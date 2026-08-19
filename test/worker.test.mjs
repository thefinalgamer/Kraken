import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Static checks on the Worker.
 *
 * These exist because of a real incident: a refactor replaced a range of text
 * that ran further than intended and deleted five commands and every button
 * handler — /rank, /leaderboard, /game, /backlog, View profile and
 * handleComponent — all at once. `node --check` passed, because the file was
 * still valid JavaScript. The unit tests passed, because they only covered
 * shared/. It shipped, and the first sign of trouble would have been a member
 * pressing a button.
 *
 * The Worker can't be imported here — it wants a Cloudflare env binding and a
 * D1 database — so these read the source instead. Crude, but they catch the
 * one failure mode that actually happened: a switch dispatching to something
 * that no longer exists.
 */
const SRC = readFileSync(
  fileURLToPath(new URL('../worker/src/index.mjs', import.meta.url)),
  'utf8',
);

const declared = () => {
  const names = new Set();
  for (const m of SRC.matchAll(/(?:async\s+)?function\s+(\w+)/g)) names.add(m[1]);
  for (const m of SRC.matchAll(/const\s+(\w+)\s*=/g)) names.add(m[1]);
  for (const m of SRC.matchAll(/import\s*\{([^}]+)\}/gs)) {
    for (const part of m[1].split(',')) names.add(part.trim().split(/\s+as\s+/).pop());
  }
  return names;
};

test('every slash command dispatches to a function that exists', () => {
  const names = declared();
  const block = SRC.slice(SRC.indexOf('async function handleCommand'));
  const cases = [...block.matchAll(/case '([\w-]+)':\s*return (\w+)\(/g)];

  assert.ok(cases.length >= 8, `expected the full command list, found ${cases.length}`);
  for (const [, command, fn] of cases) {
    assert.ok(names.has(fn), `/${command} calls ${fn}(), which is not defined anywhere`);
  }
});

test('every button dispatches to a function that exists', () => {
  const names = declared();
  const start = SRC.indexOf('async function handleComponent');
  assert.ok(start > 0, 'handleComponent is missing — every button in the bot is dead');

  const block = SRC.slice(start, start + 4000);
  for (const [, fn] of block.matchAll(/return (?:\{ \.\.\.update\(\(await )?(\w+)\(/g)) {
    if (['update', 'reply', 'errorReply'].includes(fn)) continue;
    assert.ok(names.has(fn), `a button calls ${fn}(), which is not defined anywhere`);
  }
});

test('the commands members actually use are all still present', () => {
  // Named explicitly, so deleting one is a failing test rather than a silent
  // regression. Every one of these was lost in the incident above.
  for (const fn of [
    'rank', 'leaderboard', 'game', 'backlog', 'profile', 'changelog',
    'register', 'verify', 'unlink', 'runUpdate', 'addMember',
    'handleComponent', 'handleAutocomplete', 'dispatchScan',
  ]) {
    assert.match(
      SRC,
      new RegExp(`(?:async\\s+)?function\\s+${fn}\\b`),
      `${fn}() has gone missing from the Worker`,
    );
  }
});
