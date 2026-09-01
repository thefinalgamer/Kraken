import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { faqSection, HOME_BLURB } from '../shared/faq.mjs';

/**
 * The FAQ page.
 *
 * The point of this file is the FIRST test. Everything the site and the bot
 * both say is mirrored rather than imported — tiers, the clock, supporter steps
 * — because those are a dozen lines each and mirroring beats a build-config
 * fight. A thousand words of prose is the case where that trade flips, and this
 * asserts the trade was actually made.
 */
const mod = await import('../functions/faq.js');
const { FAQ } = await import('../shared/faq.mjs');

const render = async () => {
  const res = await mod.onRequestGet();
  return { res, out: await res.text() };
};
const bodyOf = (out) => out.slice(out.indexOf('</style>'));

test('the page is built from the same module the bot answers from', async () => {
  // Not a copy. If somebody edits shared/faq.mjs, the website changes with it
  // or this fails.
  const { out } = await render();
  for (const f of FAQ) {
    assert.ok(bodyOf(out).includes(f.label), `${f.label} is missing from the page`);
  }
  assert.ok(FAQ.length >= 6, 'and every section is there');
});

test('the scoring numbers are the live ones', async () => {
  // That section is generated from the scoring config, not typed out. A
  // hand-written table would have been wrong within hours of the first tweak.
  const { out } = await render();
  const { trophyPoints } = await import('../shared/scoring.mjs');
  assert.ok(out.includes(`${trophyPoints(1)} points`), '1% rarity pays what scoring says');
  assert.ok(out.includes(`${trophyPoints(0.1)} points`), 'and so does 0.1%');
});

test('Discord markdown becomes HTML, not literal asterisks', async () => {
  const { out } = await render();
  const body = bodyOf(out);
  assert.ok(!body.includes('**'), 'no raw bold markers');
  assert.ok(!body.includes('-# '), 'no raw small-text markers');
  assert.ok(!body.includes('```'), 'no raw fences');
  assert.match(body, /<code>\/register<\/code>/, 'commands render as code');
  assert.match(body, /<pre>/, 'the scoring table keeps its spacing');
  assert.match(body, /<ul class="faqlist">/, 'bullets become a list');
  assert.match(body, /<em>now<\/em>/, 'single asterisks are italics, not literal stars');
  assert.ok(!/<em>\*/.test(body), 'and bold was consumed before italics ran');
});

test('a section does not repeat its own name inside itself', async () => {
  // The summary already says "Getting on the board". A folder whose first line
  // repeats its own label reads like a rendering bug.
  const { out } = await render();
  const body = bodyOf(out);
  assert.equal((body.match(/Getting on the board/g) || []).length, 1);
});

test('a Discord channel mention does not leak a raw id', async () => {
  // `<#123456>` is meaningless outside Discord and looks like a broken tag.
  const { out } = await render();
  assert.ok(!/&lt;#\d+&gt;/.test(out), 'no channel id in the markup');
});

test('the text is escaped before any tag is built around it', async () => {
  // The source is a file in this repo, which is a thing anybody can edit. The
  // escaping costs nothing and removes the question.
  const { out } = await render();
  assert.ok(out.includes('&quot;About Me&quot;'), 'quotes in the copy are escaped');
});

test('the page reads nothing and is cached hard', async () => {
  // No database, no bindings. It changes when somebody pushes, and a push busts
  // the cache anyway.
  const { res } = await render();
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Cache-Control'), /max-age=3600/);
});

test('the new sections are actually on it', async () => {
  const { out } = await render();
  const body = bodyOf(out);
  assert.ok(body.includes('The website'), 'the site explains itself');
  assert.ok(body.includes('Supporting Kraken'));
  assert.ok(body.includes('⏳'), 'the closing clock is explained');
  assert.ok(body.includes('/supporter'), 'and the new mod command is listed');
});

test('the supporting section says plainly that the star buys nothing', async () => {
  // If this ever stops being true in the copy, it has probably stopped being
  // true in the code.
  const { out } = await render();
  const i = out.indexOf('Supporting Kraken');
  const section = out.slice(i, i + 4000);
  assert.match(section, /Not points, not rank, not tier/);
});

test('the FAQ points at the domain we own, never a pages.dev subdomain', async () => {
  /**
   * Both free subdomains this site has lived on were flagged by Google Safe
   * Browsing — kraken-ehu for the word "kraken" matching a crypto brand sweep,
   * and platinumintel.pages.dev for reasons never established. A member
   * (Cherrius) found the stale one in the FAQ and got a full-page "Dangerous
   * site" warning, which is the worst possible first impression.
   *
   * The FAQ is the single source for both Discord and /faq on the site, so this
   * one assertion covers both surfaces.
   */
  const src = await readFile(new URL('../shared/faq.mjs', import.meta.url), 'utf8');
  assert.ok(!src.includes('pages.dev'), 'no free subdomain anywhere in the FAQ');
  assert.match(faqSection('website'), /platinumintel\.co\.uk/, 'the real domain is named');
  assert.match(HOME_BLURB, /platinumintel\.co\.uk/, 'and the home blurb agrees with it');
});

test('the FAQ explains why a game page shows a smaller number than the game is worth', () => {
  // Martin found this by comparing Borderlands 2 with JFL__Leon and getting the
  // same figure. Now that the pages show banked values, two people WILL see
  // different numbers for the same game, and the FAQ has to say why first.
  const site = faqSection('website');
  assert.match(site, /not the game's/, 'names whose number it is');
  assert.match(site, /1,400 at 100% completion and 980 at 70%/, 'with the arithmetic shown');
});

test('rivals are documented, and documented as public', () => {
  const site = faqSection('website');
  assert.match(site, /\/rivals add/, 'says how to set them');
  assert.match(site, /Everyone can see everybody's/, 'and does not imply the list is private');
});
