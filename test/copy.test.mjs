import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * House style, enforced.
 *
 * Martin, on seeing an em dash in the contested page copy: "thats a dead give
 * away AI Slop". He is right, and the fix is not to remove nineteen of them
 * once and hope. Every string a member reads is written in his voice, and the
 * punctuation is part of the voice.
 *
 * COMMENTS ARE EXEMPT, DELIBERATELY. Nobody reads the source but us, and the
 * long explanatory comments in this codebase are the most valuable thing in it.
 * The rule is about what reaches a person: a page, a card, an error message.
 *
 * This strips comments and checks what is left, which is why it catches the bot
 * replies and the FAQ as well as the website. The FAQ especially — it is the one
 * file that renders into both Discord and the site, so a slip there ships twice.
 */

/**
 * MEMBER-FACING ONLY.
 *
 * `jobs/` is deliberately not here. Those files print into the GitHub Actions
 * log, which only Martin ever opens, and holding build output to the same voice
 * as a page a member reads would turn this guard into noise that gets deleted.
 * The line is: does a person who is not us read this string.
 *
 * `functions/` is the website, `shared/` is everything both surfaces render
 * (the FAQ lives here and ships to Discord AND the site, so a slip there ships
 * twice), and `worker/` is every reply the bot gives.
 */
const ROOTS = ['functions', 'shared', 'worker'];

/** Every .js/.mjs file under the roots, comments removed. */
async function sources() {
  const out = [];
  const walk = async (dir) => {
    for (const name of await readdir(dir)) {
      const p = join(dir, name);
      if ((await stat(p)).isDirectory()) await walk(p);
      else if (/\.(js|mjs)$/.test(p)) {
        const raw = await readFile(p, 'utf8');
        out.push({
          path: p,
          /**
           * Block comments, then WHOLE-LINE // comments only.
           *
           * A trailing comment after code is left in, and that is the safe
           * direction: stripping to the first `//` on a line would eat the
           * inside of every string containing `https://`, and this guard would
           * then quietly stop seeing most of the codebase. A trailing comment
           * with a dash in it fails this test, which is a five-second fix; a
           * stripper that swallows half the source is a test that passes
           * forever while checking nothing.
           */
          code: raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''),
        });
      }
    }
  };
  for (const r of ROOTS) await walk(r);
  return out;
}

const hits = (files, ch) =>
  files.flatMap(({ path, code }) =>
    code
      .split('\n')
      .map((line, i) => ({ path, line: i + 1, text: line.trim() }))
      .filter((l) => l.text.includes(ch)),
  );

test('no em dash reaches a member, anywhere', async () => {
  const found = hits(await sources(), '—');
  assert.deepEqual(
    found.map((f) => `${f.path}:${f.line} ${f.text.slice(0, 90)}`),
    [],
    'em dashes in rendered copy',
  );
});

test('no en dash sneaks in as a substitute either', async () => {
  // The obvious way to "fix" the rule while keeping the habit. A hyphen in a
  // date range is fine; an en dash used as punctuation is the same tell.
  const found = hits(await sources(), '–');
  assert.deepEqual(
    found.map((f) => `${f.path}:${f.line} ${f.text.slice(0, 90)}`),
    [],
    'en dashes in rendered copy',
  );
});

test('the guard actually reads the files it claims to', async () => {
  /**
   * A test that silently walks nothing passes forever. This one nearly did:
   * an earlier version of the walker returned no files at all when a root was
   * missing, and reported a clean sweep of zero lines.
   */
  const files = await sources();
  // Twenty across the three member-facing roots today. The floor is a tripwire
  // for the walker breaking, not a count to keep updated, so it sits well below.
  assert.ok(files.length >= 15, `expected the member-facing code, walked ${files.length} files`);

  for (const needed of [
    'shared/faq.mjs',
    'worker/src/index.mjs',
    'functions/contested.js',
    'functions/_lib/page.js',
  ]) {
    assert.ok(files.some((f) => f.path.replace(/\\/g, '/') === needed), `${needed} was not walked`);
  }

  // And it can still see a dash when there is one to see.
  assert.equal(hits([{ path: 'x', code: 'const a = "one — two";' }], '—').length, 1);
});

test('plurals are built from the stem, not by gluing a suffix onto the singular', async () => {
  /**
   * `trophy${n === 1 ? '' : 'ies'}` renders "trophyies", and it shipped: Leon
   * screenshotted "4 trophyies in it are flagged" out of a /flag reply.
   *
   * The stem is "troph". The rule generalises to every -y word, so this looks
   * for the shape rather than the one word that caught us, and it has to be a
   * source check because the broken string only exists at runtime.
   */
  const bad = [];
  for (const { path, code } of await sources()) {
    // A template pluralisation whose literal part already ends in the singular
    // "y" while the branch supplies "ies".
    for (const m of code.matchAll(/(\w*y)\$\{[^}]*?'ies'[^}]*?\}/g)) {
      bad.push(`${path}: ${m[0].slice(0, 70)}`);
    }
  }
  assert.deepEqual(bad, [], 'these render as "<word>yies"');
});

test('the plural guard can see a broken plural when there is one', () => {
  // The test above passes on an empty codebase, so prove the pattern matches.
  const broken = "`${n} trophy${n === 1 ? '' : 'ies'} left`";
  const fixed = "`${n} troph${n === 1 ? 'y' : 'ies'} left`";
  assert.equal([...broken.matchAll(/(\w*y)\$\{[^}]*?'ies'[^}]*?\}/g)].length, 1, 'catches the bad form');
  assert.equal([...fixed.matchAll(/(\w*y)\$\{[^}]*?'ies'[^}]*?\}/g)].length, 0, 'and passes the good one');
});
