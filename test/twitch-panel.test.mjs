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

test('every ellipsis rule sits on a box that can actually ellipsis', async () => {
  /**
   * THE ONE THAT SHIPPED. `text-overflow:ellipsis` and `white-space:nowrap` do
   * NOTHING on an inline element, so a game title and the meta line under it
   * flowed into each other and ran off the right edge of the panel:
   * "The Witcher 3: Wild Hunt1,810 pts · 12 of us own", with a horizontal
   * scrollbar under it, on a live channel.
   *
   * The rules that looked right were the ones that happened to carry
   * display:block already. Nothing said the others had to, so this does: a rule
   * with text-overflow must be a block, or be blockified by being a flex item.
   */
  const css = await read('style.css');

  const offenders = [];
  for (const m of css.matchAll(/([^{}]+)\{([^}]*text-overflow[^}]*)\}/g)) {
    const selector = m[1].split('*/').pop().trim();
    const body = m[2];
    const ok = /display:\s*block/.test(body) || /flex\s*:/.test(body);
    if (!ok) offenders.push(selector);
  }

  assert.deepEqual(offenders, [], `\ninline, so the ellipsis does nothing:\n${offenders.join('\n')}\n`);
});

test('the panel body can never grow a horizontal scrollbar', async () => {
  // A backstop rather than the fix - nothing should be wider than 318 in the
  // first place - but a panel with a sideways scrollbar on somebody's channel
  // is the kind of broken people screenshot.
  const css = await read('style.css');
  const body = css.slice(css.indexOf('.body{'), css.indexOf('}', css.indexOf('.body{')));
  assert.match(body, /overflow-x:hidden/);
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

test('an unlinked channel explains itself rather than looking broken', async () => {
  const js = await readCode('panel.js');
  assert.match(js, /Channel not linked/);
  assert.match(js, /\/twitch/, 'and says which command fixes it');
});

test('WHOSE BOARD IT IS COMES FROM THE CHANNEL, NEVER FROM TYPED INPUT', async () => {
  /**
   * The hole this closes. The first version asked the broadcaster to type a PSN
   * ID and nothing stopped them typing somebody else's - the setting lived in
   * Twitch's configuration service, owned by that channel, where Kraken could
   * neither see it nor clear it. Martin: "what happens if i picked someone else
   * id, can i remove it on my end to stop grief". The answer was no.
   *
   * A panel cannot forge the channel it runs on, so identity comes from
   * onAuthorized and nowhere else. If a text box ever comes back, this fails.
   */
  const panel = await readCode('panel.js');
  const config = await readCode('config.js');

  assert.match(panel, /onAuthorized\(function \(auth\)/, 'identity is the channel');
  assert.match(panel, /auth && auth\.channelId/);
  assert.match(panel, /api\/channel\//, 'looked up server side');

  for (const [name, src] of [['panel.js', panel], ['config.js', config]]) {
    assert.ok(
      !/configuration\.set\(/.test(src),
      `${name} writes a configuration segment, which is the thing that was abusable`,
    );
    assert.ok(
      !/<input/i.test(src) && !/getElementById\('psn'\)/.test(src),
      `${name} still has somewhere to type a name`,
    );
  }

  const html = await readCode('config.html');
  assert.ok(!/<input/i.test(html), 'the settings page has no text box at all');
});

test('the settings page tells a broadcaster how to link, and nothing else', async () => {
  const js = await readCode('config.js');
  assert.match(js, /Not linked yet/);
  assert.match(js, /This channel is linked/, 'and confirms when it is');
  assert.match(js, /\/twitch/, 'naming the command that does it');
});

test('the milestone names its game, or it reads as the game above it', async () => {
  /**
   * "1 trophy from their 313th platinum" sat directly under Sea of Thieves at
   * 281/294 and read as one more SoT trophy and the plat. The milestone is the
   * nearest platinum anywhere in the library, so the game has to be on it.
   */
  const js = await read('panel.js');
  const block = js.slice(js.indexOf('if (d.milestone)'), js.indexOf('if (live)'));
  assert.match(block, /d\.milestone\.title/, 'the game title is rendered');
  assert.doesNotMatch(block, /'from their '/, 'the old sentence is gone');
});
