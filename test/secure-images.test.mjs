import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

import { secureUrl } from '../functions/_lib/page.js';

/**
 * Mixed content, and the reason it went unnoticed for so long.
 *
 * PSN serves game art from two https hosts and avatars from two PLAIN HTTP
 * ones. This site is https, so those avatars were mixed content: quietly
 * upgraded by Chrome, blocked outright elsewhere, and never simply loaded.
 * Nobody reported it because a missing avatar looks exactly like a member who
 * never set one.
 *
 * The Twitch panel is what forced it into the open - an extension declares its
 * image hosts in a CSP allowlist, and an https page cannot usefully allowlist
 * an http origin.
 */

test('http is upgraded, https is left alone', () => {
  assert.equal(
    secureUrl('http://static-resource.np.community.playstation.net/avatar/1.png'),
    'https://static-resource.np.community.playstation.net/avatar/1.png',
  );
  assert.equal(
    secureUrl('https://image.api.playstation.com/x.png'),
    'https://image.api.playstation.com/x.png',
    'and an https URL is returned untouched, character for character',
  );
});

test('anything that is not a web URL comes back empty', () => {
  /**
   * These end up inside a src attribute built from a column somebody else's API
   * filled in. A javascript: or data: URL has no business there, and returning
   * '' means the page falls back to its blank tile rather than rendering it.
   */
  for (const bad of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    '//evil.test/x.png',
    'ftp://x.test/a.png',
    '',
    null,
    undefined,
  ]) {
    assert.equal(secureUrl(bad), '', `${String(bad)} must not reach a src`);
  }
});

test('every image on the site goes through it', async () => {
  /**
   * Sixteen places render an image from the database. One that forgets is one
   * host quietly failing for one kind of row, which is precisely the bug this
   * fixes - so the rule is checked rather than remembered.
   */
  const dir = new URL('../functions/', import.meta.url);
  const walk = async (d) => {
    const out = [];
    for (const e of await readdir(d, { withFileTypes: true })) {
      const u = new URL(e.name + (e.isDirectory() ? '/' : ''), d);
      if (e.isDirectory()) out.push(...(await walk(u)));
      else if (e.name.endsWith('.js')) out.push(u);
    }
    return out;
  };

  const offenders = [];
  for (const file of await walk(dir)) {
    const src = await readFile(file, 'utf8');
    for (const m of src.matchAll(/src="\$\{([^}]*)\}"/g)) {
      if (!m[1].includes('secureUrl')) {
        offenders.push(`${file.pathname.split('/functions/')[1]}: ${m[1]}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `\n${offenders.join('\n')}\n`);
});

test('the scan stores https rather than storing the problem', async () => {
  // The other end. page.js repairs what is already there; this stops the pile
  // growing every night.
  const scan = await readFile(new URL('../jobs/scan.mjs', import.meta.url), 'utf8');
  assert.match(scan, /const https = \(url\) =>/, 'the helper exists');
  assert.match(scan, /https\(account\.avatarUrl\)/, 'avatars go through it');
  assert.match(scan, /https\(title\.trophyTitleIconUrl\)/, 'and game art does too');
  assert.ok(
    !/account\.avatarUrl \?\? null/.test(scan),
    'and the raw value is not written anywhere any more',
  );
});

test('the migration only writes rows that actually move', async () => {
  // Same rule the nightly rescore follows, so re-running it costs nothing.
  const sql = await readFile(
    new URL('../migrations/028-https-images.sql', import.meta.url), 'utf8',
  );
  const statements = sql.split(';').filter((x) => /UPDATE/i.test(x));
  assert.equal(statements.length, 3, 'members, games and trophies');
  for (const s of statements) {
    assert.match(s, /LIKE 'http:\/\/%'/, 'every update is guarded');
  }
});

test('the API hands the panel nothing it cannot render', async () => {
  const api = await readFile(
    new URL('../functions/api/hunter/[name].js', import.meta.url), 'utf8',
  );
  assert.ok(
    !/(icon|avatar)_url \?\? null/.test(api),
    'a raw column would reach the panel and be blocked by its CSP',
  );
  assert.equal((api.match(/secureUrl\(/g) || []).length >= 5, true, 'every image field');
});
