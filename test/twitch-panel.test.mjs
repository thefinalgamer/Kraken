import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

/**
 * The Twitch extension's static files.
 *
 * EVERY RULE HERE FAILS SILENTLY IF BROKEN, which is the whole reason the file
 * exists. Twitch serves extensions under `script-src 'self'` plus its own
 * helper host: an inline script or an onclick attribute is dropped without a
 * console error anybody will see, and the panel renders as a dead box on
 * somebody's channel while every other test in this repo stays green.
 */
const dir = new URL('../twitch/', import.meta.url);
const read = (f) => readFile(new URL(f, dir), 'utf8');

/**
 * COMMENTS ARE STRIPPED BEFORE ANYTHING IS CHECKED.
 *
 * These files explain the CSP rules in their own headers, so the prose contains
 * the exact strings the rules forbid - a comment saying "no inline <script>"
 * failed the no-inline-script test on the first run. A guard that cannot tell
 * an explanation from the thing it explains forces the reasoning out of the
 * file, which is the opposite of what it is for.
 */
const code = (src) =>
  src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const readCode = async (f) => code(await read(f));

const HTML = ['panel.html', 'config.html'];

test('no inline javascript anywhere, in any form', async () => {
  for (const f of HTML) {
    const src = await readCode(f);

    // A <script> tag may only have a src. A block with a body is dropped.
    for (const m of src.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      assert.match(m[1], /\ssrc=/, `${f} has a <script> block with no src`);
      assert.equal(m[2].trim(), '', `${f} has code inside a <script> tag`);
    }

    // onclick, onload, onerror ... all of them are inline handlers.
    assert.ok(!/\son[a-z]+\s*=/i.test(src), `${f} has an inline event handler attribute`);
    assert.ok(!/javascript:/i.test(src), `${f} has a javascript: url`);
  }
});

test('every script and stylesheet ships inside the zip, bar the Twitch helper', async () => {
  /**
   * Twitch requires that all front-end HTML, CSS and JS is in the uploaded
   * package. The one host allowed from outside is the extension helper, which
   * is how the panel learns whose channel it is on.
   */
  const files = new Set(await readdir(dir));

  for (const f of HTML) {
    const src = await readCode(f);

    for (const m of src.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) {
      const url = m[1];
      if (url.startsWith('https://extension-files.twitch.tv/')) continue;
      assert.ok(!/^https?:/.test(url), `${f} loads a script from outside the package: ${url}`);
      assert.ok(files.has(url), `${f} references ${url}, which is not in twitch/`);
    }

    for (const m of src.matchAll(/<link[^>]*\shref="([^"]+)"/g)) {
      const url = m[1];
      assert.ok(!/^https?:/.test(url), `${f} loads a stylesheet from outside: ${url}`);
      assert.ok(files.has(url), `${f} references ${url}, which is not in twitch/`);
    }
  }
});

test('no web fonts, because the CSP will not load them', async () => {
  const css = await readCode('style.css');
  assert.ok(!/@import/.test(css), 'an @import would be blocked');
  assert.ok(!/fonts\.googleapis|fonts\.gstatic/.test(css), 'no Google Fonts');
  assert.ok(!/url\(\s*['"]?https?:/.test(css), 'and nothing else fetched from a URL either');
});

test('nothing is built from data with innerHTML', async () => {
  /**
   * A PSN id is a string somebody else chose, and this runs on a stranger's
   * channel. The DOM is assembled with createElement and textContent so there
   * is no path at all from a name to markup.
   */
  for (const f of ['panel.js', 'config.js']) {
    const src = await readCode(f);
    assert.ok(!/innerHTML/.test(src), `${f} uses innerHTML`);
    assert.ok(!/outerHTML|insertAdjacentHTML|document\.write/.test(src), `${f} writes raw markup`);
    assert.ok(!/\beval\s*\(|new Function\s*\(/.test(src), `${f} evaluates a string`);
  }
});

test('the panel talks to the board over https, and only the board', async () => {
  // Whatever this fetches has to be on the Allowlist for URL Fetching Domains
  // in the developer console. One host keeps that list honest.
  const hosts = new Set();
  for (const f of ['panel.js', 'config.js']) {
    const src = await readCode(f);
    for (const m of src.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) hosts.add(m[1].toLowerCase());
  }
  hosts.delete('extension-files.twitch.tv');
  // The SVG namespace is an identifier, not an address - createElementNS never
  // fetches it - but it is the one plain-http string allowed to exist here.
  hosts.delete('www.w3.org');
  assert.deepEqual([...hosts], ['platinumintel.co.uk']);

  const panel = await readCode('panel.js');
  assert.ok(
    !/http:\/\/(?!www\.w3\.org\/)/.test(panel),
    'no plain http anywhere but the SVG namespace',
  );
});

test('the four tabs exist in the markup and every one has a handler', async () => {
  const html = await readCode('panel.html');
  const js = await readCode('panel.js');

  const tabs = [...html.matchAll(/data-tab="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(tabs, ['now', 'list', 'hunter', 'board']);

  // The handler is attached in JS, since an onclick attribute would be dropped.
  assert.match(js, /addEventListener\('click'/);
  for (const t of tabs) assert.match(js, new RegExp(`\\b${t}:`), `no renderer for the ${t} tab`);
});

test('a panel that has already drawn is never replaced by an error', async () => {
  /**
   * This is on somebody's channel. Swapping a working board for "cannot reach"
   * because one refresh timed out is worse than being thirty seconds stale.
   */
  const js = await readCode('panel.js');
  const fail = js.slice(js.indexOf('.catch(function (err)'));
  assert.ok(fail.length > 40, 'the slice found the catch');
  // First thing in the handler, before any state is shown.
  assert.match(fail.slice(0, 120), /if \(state\.data\) return;/);
});

test('an unconfigured panel explains itself rather than looking broken', async () => {
  const js = await readCode('panel.js');
  assert.match(js, /Not set up yet/);
  assert.match(js, /Not on the board/, 'and a wrong name says which name');
});

test('the config page checks a name against the board before saving it', async () => {
  // A typo that saves cleanly costs the broadcaster an empty panel in front of
  // their viewers, with no clue why.
  const js = await readCode('config.js');
  assert.match(js, /fetch\(API \+ encodeURIComponent\(psn\)/);
  assert.ok(
    js.indexOf('fetch(API') < js.indexOf('store(exact)'),
    'it must ask the board BEFORE it stores anything',
  );
  assert.match(js, /data\.hunter\.name/, 'and stores the spelling the board uses');
});
