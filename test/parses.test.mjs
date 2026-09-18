import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';

/**
 * EVERY SOURCE FILE IS VALID JAVASCRIPT.
 *
 * This is the cheapest test in the suite and it is here because the same
 * mistake has now been made five times: a BACKTICK INSIDE A COMMENT that lives
 * inside a template literal. It closes the string, the rest of the statement
 * becomes nonsense, and the file stops parsing.
 *
 * Four of those were in the site's CSS, which test/ui.test.mjs guards. The
 * fifth was in a SQL comment in jobs/scan.mjs - the nightly scan, the single
 * most important file in the repo - and NOTHING CAUGHT IT. The whole suite went
 * green, because the tests that cover the scan read it as text rather than
 * importing it, and the pages that do get imported were fine.
 *
 * A per-file guard would have to be written again for every new kind of
 * embedded comment. `node --check` does not care what broke the file, only that
 * it is broken, so this covers the case nobody has thought of yet.
 *
 * It does NOT run the files. A syntax check loads nothing, connects to nothing
 * and takes a few milliseconds each, so a job that wants a Cloudflare binding
 * or a PSN cookie is checked the same as anything else.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP = new Set(['node_modules', '.git', '.wrangler', 'dist', 'coverage']);

const sources = (dir = ROOT, found = []) => {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sources(full, found);
    else if (/\.m?js$/.test(name)) found.push(full);
  }
  return found;
};

test('every .js and .mjs in the repo parses', () => {
  const files = sources();
  // A guard that silently found nothing is worse than no guard. The repo has
  // well over fifty source files; if this drops to a handful the walk broke.
  assert.ok(files.length > 40, `only found ${files.length} source files`);

  const broken = [];
  for (const file of files) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (err) {
      const why = String(err.stderr ?? err.message)
        .split('\n')
        .find((l) => /SyntaxError/.test(l)) ?? 'did not parse';
      broken.push(`${relative(ROOT, file)}: ${why.trim()}`);
    }
  }

  assert.deepEqual(broken, [], `\n${broken.join('\n')}\n`);
});

/**
 * EVERY .sql IN tools/ SURVIVES BEING PASTED.
 *
 * These files are not run by anything. They are opened in a text editor,
 * copied, and pasted into the Cloudflare D1 console by hand - and a paste can
 * arrive there as ONE LINE, with every newline gone.
 *
 * A double-dash comment that starts such a line therefore comments out the
 * ENTIRE query, and the console answers "Requests without any query are not
 * supported". That is exactly what happened to tools/audit.sql, whose eleven
 * lines of helpful preamble ate the audit underneath them.
 *
 * So: block comments only, and no semicolon inside one either, because a
 * console that splits a paste on semicolons will cut the comment in half and
 * hand the remainder to the parser as if it were SQL.
 *
 * The console also has a size limit it does not advertise. A four thousand
 * character audit arrived there cut off at about two thousand one hundred, and
 * came back "incomplete input". So each statement stays short enough to paste
 * whole, and a file with more to ask splits itself into several.
 */
const PASTE_LIMIT = 1500;
const sqlFiles = () => {
  const dir = join(ROOT, 'tools');
  return readdirSync(dir)
    .filter((n) => n.endsWith('.sql'))
    .map((n) => join(dir, n));
};

test('every .sql in tools/ survives being pasted as a single line', () => {
  const files = sqlFiles();
  assert.ok(files.length > 0, 'found no .sql files in tools/');

  const broken = [];
  for (const file of files) {
    const name = relative(ROOT, file);
    const text = readFileSync(file, 'utf8');

    if (text.includes('--')) {
      broken.push(`${name}: uses a double-dash comment, which eats the query when the paste arrives as one line`);
    }
    for (const comment of text.match(/\/\*[\s\S]*?\*\//g) ?? []) {
      if (comment.includes(';')) {
        broken.push(`${name}: a block comment contains a semicolon, which splits it in half`);
      }
    }

    // What the console sees in the worst case: every newline collapsed.
    const flat = text.replace(/\s*\n\s*/g, ' ');
    const statements = flat
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!statements.length) {
      broken.push(`${name}: nothing left to run once flattened`);
    }
    for (const s of statements) {
      if (!/^(SELECT|WITH|UPDATE|INSERT|CREATE|PRAGMA|EXPLAIN)\b/i.test(s)) {
        broken.push(`${name}: a flattened statement starts with "${s.slice(0, 40)}"`);
      }
      if (s.length > PASTE_LIMIT) {
        broken.push(
          `${name}: a statement is ${s.length} characters, over the ${PASTE_LIMIT} ` +
            `the console will take - split it into several`,
        );
      }
    }
  }

  assert.deepEqual(broken, [], `\n${broken.join('\n')}\n`);
});
