import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
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
