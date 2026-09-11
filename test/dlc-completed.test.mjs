import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { groupBlocks } from '../shared/ui.mjs';

/**
 * "X completed X DLC".
 *
 * Martin: *"dlcs when someone completed it, say x completed x dlc?"*. All of it
 * was already in the database and unused. Migration 012 put `trophies.group_id`
 * on every trophy and `trophy_groups` holds each pack's name; 1,142 of the
 * 1,144 owned games with DLC already had their names filled in.
 *
 * `scan.mjs` runs main() at import, so its half is read as text.
 */
const scan = await readFile(new URL('../jobs/scan.mjs', import.meta.url), 'utf8');
const code = scan.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const ME = { psn_online_id: 'Khakugo', completion: 70.9 };

test('a pack that finished this session is announced, by its real name', () => {
  const out = JSON.stringify(groupBlocks(ME, [
    { base: false, name: 'Vessel of Hatred', title: 'Diablo IV', size: 8, icon_url: null },
  ]));

  assert.match(out, /Khakugo finished Vessel of Hatred/);
  assert.match(out, /Diablo IV/, 'and which game it belongs to');
  assert.match(out, /8 trophies/);
});

test('finishing the base game is its own sentence', () => {
  /**
   * THE GAP NOBODY HAD NAMED. The existing #completed card fires at 100% of the
   * whole TITLE, so somebody who plats the base game of a title with expansions
   * they do not own gets total silence. That is a real achievement going
   * unmarked, and it came free once groups could be detected at all.
   */
  const out = JSON.stringify(groupBlocks(ME, [
    { base: true, name: 'the base game', title: 'Diablo IV', size: 38, icon_url: null },
  ]));

  assert.match(out, /finished the base game of Diablo IV/);
  assert.ok(!/finished the base game of the base game/.test(out), 'and not twice over');
});

test('it never wears the green tick', () => {
  /**
   * A tick already means "100%'d the whole game" in that channel and has for
   * months. Reusing it for a slice of a game would quietly devalue every tick
   * that came before it.
   */
  const out = JSON.stringify(groupBlocks(ME, [
    { base: false, name: 'Vessel of Hatred', title: 'Diablo IV', size: 8 },
  ]));
  assert.ok(!out.includes('✅'), 'the tick belongs to whole titles');
  assert.match(out, /🧩/, 'a pack has its own mark');
});

test('several in one session become one card, and it names the game', () => {
  /**
   * "finished 3 of them" was the first heading and it assumes the reader saw
   * something that is not there. Somebody clearing several packs in a session
   * is nearly always clearing them in ONE game, so say which -- and then the
   * rows underneath must not repeat it.
   */
  const out = JSON.stringify(groupBlocks(ME, [
    { base: true, name: 'the base game', title: 'Minecraft', size: 90 },
    { base: false, name: 'Nether Update', title: 'Minecraft', size: 12 },
    { base: false, name: 'Caves and Cliffs', title: 'Minecraft', size: 9 },
  ]));

  assert.match(out, /finished 3 parts of Minecraft/);
  assert.match(out, /Nether Update/);
  assert.match(out, /Caves and Cliffs/);
  assert.equal(
    (out.match(/Minecraft/g) ?? []).length, 1,
    'the game is named once, in the heading, and not on every row',
  );
});

test('packs spanning two games say which is which', () => {
  const out = JSON.stringify(groupBlocks(ME, [
    { base: false, name: 'Vessel of Hatred', title: 'Diablo IV', size: 8 },
    { base: false, name: 'Nether Update', title: 'Minecraft', size: 12 },
  ]));
  assert.match(out, /finished 2 DLC packs/, 'no single game to name');
  assert.match(out, /Diablo IV/);
  assert.match(out, /Minecraft/);
});

test('base games across two titles are called base games, not DLC packs', () => {
  /**
   * Shamansoull, 10 September: "finished 2 DLC packs" over two rows that each
   * said "Base game". JFL_Leon: *"2 base games but says its dlc packs"*. The
   * rows were right; the heading counted everything as a pack.
   */
  const out = JSON.stringify(groupBlocks(ME, [
    { base: true, name: 'the base game', title: "Assassin's Creed IV Black Flag", size: 51 },
    { base: true, name: 'the base game', title: 'Enter The Gungeon', size: 49 },
  ]));
  assert.match(out, /finished 2 base games/);
  assert.doesNotMatch(out, /DLC/, 'there is no DLC on this card');
  assert.match(out, /Black Flag\*\*\\n-# Base game · 51 trophies/, 'the game leads the row');
});

test('a mix of base games and packs names both', () => {
  const one = JSON.stringify(groupBlocks(ME, [
    { base: true, name: 'the base game', title: 'Returnal', size: 30 },
    { base: false, name: 'Vessel of Hatred', title: 'Diablo IV', size: 8 },
  ]));
  assert.match(one, /finished 1 base game and 1 DLC pack\b/);

  const many = JSON.stringify(groupBlocks(ME, [
    { base: true, name: 'the base game', title: 'Returnal', size: 30 },
    { base: false, name: 'Vessel of Hatred', title: 'Diablo IV', size: 8 },
    { base: false, name: 'Nether Update', title: 'Minecraft', size: 12 },
  ]));
  assert.match(many, /finished 1 base game and 2 DLC packs/);
});

test('the sub-line never repeats the pack name above it', () => {
  /**
   * The first version read: "finished Vessel of Hatred / Diablo IV · Vessel of
   * Hatred · 8 trophies". A stutter, and the kind that is invisible until you
   * see it rendered.
   */
  const blocks = groupBlocks(ME, [
    { base: false, name: 'Vessel of Hatred', title: 'Diablo IV', size: 8 },
  ]);

  /**
   * Rendered TEXT only. The thumbnail carries the pack name as its alt text,
   * which is right for a screen reader and invisible to everybody else, so
   * counting it as a repeat would fail a card that reads perfectly.
   */
  const shown = (JSON.stringify(blocks).match(/"content":"(.*?)"(?=,|})/g) ?? [])
    .map((m) => JSON.parse(`{${m}}`).content)
    .join('\n');

  assert.match(shown, /finished Vessel of Hatred/);
  assert.equal((shown.match(/Vessel of Hatred/g) ?? []).length, 1, 'named once on screen');
  assert.match(shown, /Diablo IV · 8 trophies/, 'the sub-line is the game and the size');
});

test('nothing to say means no card at all', () => {
  assert.equal(groupBlocks(ME, []), null);
  assert.equal(groupBlocks(ME, null), null);
});

test('a single-group game is left to the 100% card', () => {
  /**
   * On a game with no expansions, "finished the base game" and "finished the
   * game" are the same event. Two messages for one thing is worse than either.
   */
  assert.match(code, /if \(packs\.size < 2\) continue;/, 'one group, nothing to announce');
});

test('a game we have never seen cannot have completed a pack this session', () => {
  /**
   * No "before" means nothing can have changed. Announcing an expansion
   * somebody finished three years ago is the same mistake as announcing a
   * stream that ended yesterday.
   */
  assert.match(code, /c\.kind !== 'new' && c\.new_trophy_ids\?\.length/,
    'first sightings are not candidates');
});

test('"before" is derived by subtracting what they earned this session', () => {
  /**
   * The transition test, and the only thing that stops a pack finished last
   * month being announced today. Complete now AND not complete before.
   */
  assert.match(code, /if \(!complete\(trophyIds, false\)\) continue;/, 'complete now');
  assert.match(code, /if \(complete\(trophyIds, true\)\) continue;/, 'and not already complete');
  assert.match(code, /const gained = new Set\(entry\.new_trophy_ids\.map\(Number\)\)/,
    'before = now minus this session');
});

test('the lookups are batched, not one per game', () => {
  /**
   * Same reasoning as priceTheChangelog. A query per game inside the scan loop
   * is thousands of round trips on a large library; three afterwards is the
   * same answer.
   */
  const fn = code.slice(code.indexOf('async function findCompletedGroups'),
                        code.indexOf('async function priceTheChangelog'));
  assert.match(fn, /i \+= 80/, 'paged for the 100-parameter ceiling');
  assert.ok(
    (fn.match(/await db\.query\(/g) ?? []).length <= 3,
    'three queries, not one per game',
  );
  assert.ok(!/for \(const c of candidates\)[\s\S]{0,200}await db\./.test(fn),
    'and nothing queries inside a per-game loop');
});

test('a pack with no name still gets announced', () => {
  /**
   * `trophy_groups.name` is nullable on purpose -- migration 012 says a game can
   * be known to have three groups before anybody has fetched what they are
   * called. "Pack 2" beats silence, and beats a bare "001" by a mile.
   */
  assert.match(code, /`Pack \$\{f\.group_id\}`/, 'a fallback name exists');

  const out = JSON.stringify(groupBlocks(ME, [
    { base: false, name: 'Pack 002', title: 'Minecraft', size: 12 },
  ]));
  assert.match(out, /Pack 002/);
});

test('a first scan announces nothing', async () => {
  const discord = await readFile(new URL('../jobs/lib/discord.mjs', import.meta.url), 'utf8');
  const fn = discord.slice(discord.indexOf('export async function postGroupCompletions'),
                           discord.indexOf('export async function postProjects'));

  assert.match(fn, /if \(first \|\| !channel/, 'silent on a first scan, and off without a channel');
  assert.match(fn, /DISCORD_COMPLETED_CHANNEL_ID/, 'and it goes to #completed');
});
