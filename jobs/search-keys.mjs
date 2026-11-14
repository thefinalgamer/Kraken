/**
 * Fill in games.title_search for every game already in the database.
 *
 * WHY IT EXISTS. Migration 043 adds the column; it cannot fill it. The value is
 * the output of searchKey() in shared/search.mjs, which needs Unicode
 * normalisation and a regex, and D1's SQLite has neither. So the one-off pass
 * over the existing 26,504 rows has to happen in JavaScript, here.
 *
 *   Actions -> Admin -> Run workflow -> task: backfill-search
 *
 * NO PSN CALLS. This reads and writes D1 and nothing else, so it cannot fail in
 * a way that loses data, cannot be rate limited, and can be run at any time
 * without waiting for a scan lane. It takes a couple of minutes.
 *
 * IDEMPOTENT, AND THAT IS THE POINT. It writes only rows whose stored key
 * differs from the freshly computed one, so running it twice costs one read
 * pass and no writes. That also makes it the repair tool: if searchKey() is
 * ever changed, running this is how every existing row picks up the new rule.
 *
 * SAFE TO LEAVE UNRUN, briefly. Until a row has a key, the pages fall back to
 * matching on `title` exactly as they did before, so a half-filled column
 * behaves like today's search rather than like a broken one. See the fallback
 * in listSql() in functions/games.js.
 */

import { D1 } from './lib/d1.mjs';
import { searchKey } from '../shared/search.mjs';

const env = process.env;

const db = new D1({
  accountId: env.CF_ACCOUNT_ID,
  databaseId: env.CF_D1_DATABASE_ID,
  apiToken: env.CF_API_TOKEN,
});

/** Rows per read. Titles are short, so this is comfortable. */
const PAGE = 2000;

/**
 * Rows per write.
 *
 * The statement binds the id, the key and the id again (once for the CASE and
 * once for the IN), so it is three parameters a row against D1's ceiling of a
 * hundred. chunkSize does that division rather than a guessed constant, for the
 * same reason batchInsert does.
 */
const PER_WRITE = D1.chunkSize(3);

/**
 * One statement, many rows. The alternative is an UPDATE per game, which for
 * 26,504 games is 26,504 round trips to D1 and turns two minutes into an hour.
 */
async function writeKeys(rows) {
  for (let i = 0; i < rows.length; i += PER_WRITE) {
    const slice = rows.slice(i, i + PER_WRITE);
    const cases = slice.map(() => 'WHEN ? THEN ?').join(' ');
    const ids = slice.map(() => '?').join(',');
    await db.run(
      `UPDATE games
          SET title_search = CASE np_comm_id ${cases} END
        WHERE np_comm_id IN (${ids})`,
      [...slice.flatMap((r) => [r.np_comm_id, r.key]), ...slice.map((r) => r.np_comm_id)],
    );
  }
}

const before = await db.one(
  'SELECT COUNT(*) AS total, SUM(title_search IS NULL) AS unfilled FROM games',
);
console.log(
  `${Number(before?.total ?? 0).toLocaleString('en-GB')} games, ` +
    `${Number(before?.unfilled ?? 0).toLocaleString('en-GB')} with no search key yet.\n`,
);

let seen = 0;
let written = 0;
let blank = 0;
// Paged on the primary key rather than LIMIT/OFFSET: an offset deep into a
// 26,000-row table re-reads everything before it on every page, and this way
// each page is an index seek.
let after = '';

for (;;) {
  const games = await db.query(
    `SELECT np_comm_id, title, title_search
       FROM games
      WHERE np_comm_id > ?
      ORDER BY np_comm_id
      LIMIT ?`,
    [after, PAGE],
  );
  if (!games.length) break;

  const changed = [];
  for (const g of games) {
    const key = searchKey(g.title);
    /*
     * A TITLE THAT NORMALISES TO NOTHING keeps a key of '', not NULL. The two
     * are different: NULL means "never computed" and the pages fall back to
     * matching the raw title, while '' means "computed, and there is nothing
     * typeable in it". A game called "???" is genuinely unsearchable, and
     * recording that honestly stops this job rewriting the same row forever.
     */
    if (key !== (g.title_search ?? null)) changed.push({ np_comm_id: g.np_comm_id, key });
    if (!key) blank++;
  }

  await writeKeys(changed);

  seen += games.length;
  written += changed.length;
  after = games[games.length - 1].np_comm_id;
  console.log(
    `  ${seen.toLocaleString('en-GB')} read, ${written.toLocaleString('en-GB')} written`,
  );
}

const left = await db.one('SELECT SUM(title_search IS NULL) AS unfilled FROM games');
const unfilled = Number(left?.unfilled ?? 0);

console.log(
  `\nDone. ${seen.toLocaleString('en-GB')} games read, ` +
    `${written.toLocaleString('en-GB')} keys written, ` +
    `${unfilled.toLocaleString('en-GB')} still without one.`,
);
if (blank) {
  console.log(
    `${blank.toLocaleString('en-GB')} title(s) have nothing typeable in them at all ` +
      '(punctuation or symbols only). Those are stored as an empty key, not skipped.',
  );
}
if (unfilled > 0) {
  console.log('\nThat should be zero. Run it again; it only writes what is missing.');
  process.exitCode = 1;
}
