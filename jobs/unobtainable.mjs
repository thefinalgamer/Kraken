/**
 * Import the PSNP+ community list of games with unobtainable trophies.
 *
 * https://psnp-plus.huskycode.dev  —  crowd-sourced, volunteer-submitted, and
 * the only source that exists for this. PSN cannot tell us a trophy is dead: a
 * trophy dies when a server is switched off or an event ends, and Sony's API
 * returns an identical row either way. Somebody has to have played it and said
 * so, and 1,597 lists of people having done exactly that is a gift.
 *
 * THE ONE HARD PROBLEM: their list has no np_comm_id. It is keyed by
 * PSNProfiles' own numeric game ids, and nothing in an entry maps back to
 * Sony's identifiers. So the join has to go through TITLE and PLATFORM, which
 * is fuzzy, and the rule we set when the automatic detection idea was rejected
 * still holds: a wrong warning is worse than no warning, because it tells
 * somebody not to start a game that is perfectly completable.
 *
 * Hence DRY RUN BY DEFAULT. It prints exactly what it would do and writes
 * nothing until UNOBTAINABLE_WRITE=1 is set. Look at the report first.
 *
 * WHAT WE DELIBERATELY IGNORE: their `trophies` array. It uses PSNProfiles'
 * own trophy numbering, which would be a second guess stacked on top of the
 * first. Our flag is per GAME, so we never need it, and dropping it removes
 * the riskiest half of the mapping.
 *
 * A HUMAN ALWAYS WINS. Rows are only touched where flagged_by is NULL or
 * 'psnp-plus'. If a mod clears a flag with /flag, this leaves it cleared
 * forever — their judgement beats a title match, permanently.
 *
 *   Actions -> Admin -> Run workflow -> task: import-unobtainable
 */

import { D1 } from './lib/d1.mjs';

const env = process.env;
const SOURCE = 'https://psnp-plus.huskycode.dev/list.json';
const WRITE = env.UNOBTAINABLE_WRITE === '1';
const NOTE_MAX = 300;

// Above this many of our rows for one of their entries, something is wrong with
// the title rather than right with the match. Reported, never written.
const WIDE_MATCH = 4;

const db = new D1({
  accountId: env.CF_ACCOUNT_ID,
  databaseId: env.CF_D1_DATABASE_ID,
  apiToken: env.CF_API_TOKEN,
});

/**
 * Titles, made comparable.
 *
 * PSN and PSNProfiles do not spell things the same way. Trademark symbols,
 * ampersands, colons, apostrophes of three different kinds. This strips
 * everything that is punctuation rather than meaning.
 *
 * It deliberately KEEPS leading "The". Dropping it matches more, and one of the
 * things it would match is a different game.
 */
const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[™®©]/g, '')      // (tm) (r) (c)
    .replace(/[‘’ʼ`]/g, "'")     // curly apostrophes
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9']+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** "PS4,PS5" and ["PS4"] compared honestly. */
const platformsOf = (s) =>
  String(s ?? '')
    .toUpperCase()
    .split(/[,\s/]+/)
    .map((p) => p.replace(/[^A-Z0-9]/g, ''))
    .filter(Boolean);

const overlaps = (ours, theirs) => {
  const mine = new Set(platformsOf(ours));
  return (theirs ?? []).some((p) => mine.has(String(p).toUpperCase().replace(/[^A-Z0-9]/g, '')));
};

// ------------------------------------------------------------------ load ---

console.log(`Fetching ${SOURCE}`);
const res = await fetch(SOURCE, { headers: { 'User-Agent': 'Kraken/1.0 (Platinum Intel Discord bot)' } });
if (!res.ok) throw new Error(`PSNP+ list returned ${res.status}`);
const payload = await res.json();
const entries = Object.entries(payload.list ?? {});
console.log(`  list version ${payload.version}, ${entries.length} trophy lists\n`);

console.log('Loading our games...');
const ours = [];
for (let offset = 0; ; offset += 2000) {
  const rows = await db.query(
    `SELECT np_comm_id, title, platform, local_started, unobtainable, flagged_by
       FROM games
      WHERE title IS NOT NULL AND TRIM(title) <> ''
      ORDER BY np_comm_id LIMIT 2000 OFFSET ?`,
    [offset],
  );
  if (!rows.length) break;
  ours.push(...rows);
  if (rows.length < 2000) break;
}
console.log(`  ${ours.length} games with titles\n`);

const byTitle = new Map();
for (const g of ours) {
  const key = norm(g.title);
  if (!key) continue;
  if (!byTitle.has(key)) byTitle.set(key, []);
  byTitle.get(key).push(g);
}

// ----------------------------------------------------------------- match ---

const matched = [];      // title AND platform agree
const titleOnly = [];    // title agrees, platform does not
const wide = [];         // suspiciously many of our rows for one entry
const missing = [];      // nothing of ours looks like it

for (const [id, e] of entries) {
  const candidates = byTitle.get(norm(e.title));
  if (!candidates?.length) {
    missing.push(e.title);
    continue;
  }

  const hits = candidates.filter((g) => overlaps(g.platform, e.platforms));
  if (!hits.length) {
    titleOnly.push({ e, candidates });
    continue;
  }
  if (hits.length >= WIDE_MATCH) {
    wide.push({ e, hits });
    continue;
  }
  matched.push({ id, e, hits });
}

// ---------------------------------------------------------------- report ---

const owned = (m) => m.hits.some((g) => (g.local_started ?? 0) > 0);
const ownedMatches = matched.filter(owned);
const rowsToWrite = matched.flatMap((m) =>
  m.hits.filter((g) => !g.flagged_by || g.flagged_by === 'psnp-plus').map((g) => ({ g, e: m.e })),
);
const protectedRows = matched
  .flatMap((m) => m.hits)
  .filter((g) => g.flagged_by && g.flagged_by !== 'psnp-plus');

console.log('='.repeat(64));
console.log(`  ${entries.length} entries in the PSNP+ list`);
console.log(`  ${matched.length} matched on title AND platform`);
console.log(`  ${ownedMatches.length} of those are games somebody here owns`);
console.log(`  ${titleOnly.length} matched the title but no platform in common`);
console.log(`  ${wide.length} matched ${WIDE_MATCH}+ of our rows (too loose, skipped)`);
console.log(`  ${missing.length} we have never seen`);
console.log(`  ${rowsToWrite.length} game rows would be flagged`);
if (protectedRows.length) {
  console.log(`  ${protectedRows.length} left alone because a human set them`);
}
console.log('='.repeat(64));

console.log('\nGAMES SOMEBODY HERE OWNS (these are the ones that matter):');
const shown = ownedMatches
  .sort((a, b) => Math.max(...b.hits.map((g) => g.local_started ?? 0)) - Math.max(...a.hits.map((g) => g.local_started ?? 0)))
  .slice(0, 40);
for (const m of shown) {
  const owners = Math.max(...m.hits.map((g) => g.local_started ?? 0));
  console.log(`  ${String(owners).padStart(3)} owners  ${m.e.title}  [${m.hits.map((g) => g.platform).join(', ')}]`);
  console.log(`             ${String(m.e.note ?? '').slice(0, 110)}`);
}
if (ownedMatches.length > shown.length) {
  console.log(`  ...and ${ownedMatches.length - shown.length} more.`);
}

if (wide.length) {
  console.log(`\nTOO LOOSE, SKIPPED (one entry matching ${WIDE_MATCH}+ of our games usually means`);
  console.log('two different games share a name):');
  for (const w of wide.slice(0, 15)) {
    console.log(`  ${w.e.title} -> ${w.hits.length} rows`);
  }
}

if (titleOnly.length) {
  console.log('\nTITLE MATCHED BUT PLATFORM DID NOT (not written, worth an eye):');
  for (const t of titleOnly.slice(0, 15)) {
    console.log(
      `  ${t.e.title}  theirs [${(t.e.platforms ?? []).join(',')}]  ` +
        `ours [${[...new Set(t.candidates.map((g) => g.platform))].join(', ')}]`,
    );
  }
}

// ----------------------------------------------------------------- write ---

if (!WRITE) {
  console.log('\nDRY RUN. Nothing was written.');
  console.log('Set UNOBTAINABLE_WRITE=1 on the workflow step to apply this.');
  process.exit(0);
}

console.log(`\nWriting ${rowsToWrite.length} rows...`);
let written = 0;
const now = Date.now();
for (const { g, e } of rowsToWrite) {
  const note = `${String(e.note ?? 'Has unobtainable trophies.').trim().slice(0, NOTE_MAX)}`;
  await db.run(
    `UPDATE games
        SET unobtainable = 1, unobtainable_note = ?, flagged_by = 'psnp-plus', flagged_at = ?
      WHERE np_comm_id = ?`,
    [note, now, g.np_comm_id],
  );
  written++;
  if (written % 100 === 0) console.log(`  ${written}/${rowsToWrite.length}`);
}
console.log(`\nFlagged ${written} games from the PSNP+ community list.`);
console.log('Credit: https://psnp-plus.huskycode.dev — crowd-sourced by trophy hunters.');
