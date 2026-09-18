import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * A DIAGNOSTIC THAT NAMES THE WRONG CAUSE IS WORSE THAN NO DIAGNOSTIC.
 *
 * syncTierRoles counted two unrelated failures in one variable:
 *
 *   1. Discord will not look the member up at all. They left the server. The
 *      board still has them, Discord does not, and there is nothing to fix.
 *   2. Discord refuses the role change. That IS a permissions fault, and the
 *      job prints a long explainer about MANAGE ROLES and role order.
 *
 * The explainer fired on the TOTAL. So three members who had simply left
 * produced "every role change failed" plus a confident lecture about
 * permissions, aimed at a server where the bot role had been correctly
 * configured and sitting at the top for over a month. Martin read it, checked,
 * and knew it was wrong -- which is the only reason it did not send him off to
 * rearrange a working server.
 *
 * Static, like test/names.test.mjs: syncTierRoles needs a bot token and a live
 * guild, and `rest` is module-private so there is nothing to stub.
 */
const SRC = readFileSync(
  fileURLToPath(new URL('../jobs/lib/discord.mjs', import.meta.url)),
  'utf8',
);

/** syncTierRoles on its own, so nothing below can match code elsewhere. */
const syncTierRoles = () => {
  const from = SRC.indexOf('export async function syncTierRoles');
  assert.ok(from > 0, 'syncTierRoles is missing');
  const to = SRC.indexOf('\n}', SRC.indexOf('return { changed', from));
  assert.ok(to > from, 'syncTierRoles does not return where it used to');
  return SRC.slice(from, to);
};

test('a member who left the server is counted apart from a refused role change', () => {
  const fn = syncTierRoles();
  assert.match(fn, /let missing = 0;/, 'could not look them up');
  assert.match(fn, /let refused = 0;/, 'Discord said no');
  assert.ok(!/^\s*let skipped = 0;/m.test(fn),
    'one counter for two faults is what caused the wrong diagnosis');
});

test('the permissions explainer fires ONLY on a refusal', () => {
  const fn = syncTierRoles();
  assert.match(fn, /if \(refused && !changed\) \{/,
    'gated on a real refusal, not on the combined total');

  // The explainer must sit inside that branch, not somewhere a departure can
  // reach. Find where the branch opens and check the text comes after it.
  const gate = fn.indexOf('if (refused && !changed)');
  const lecture = fn.indexOf('50001 Missing Access');
  assert.ok(lecture > gate, 'the MANAGE ROLES explainer escaped its condition');
});

test('a departure gets its own line, and it says nothing about permissions', () => {
  const fn = syncTierRoles();
  assert.match(fn, /if \(missing && !refused\)/,
    'the quiet case is explained rather than left to the scary one');

  const start = fn.indexOf('if (missing && !refused)');
  const note = fn.slice(start, fn.indexOf('if (refused && !changed)'));
  assert.match(note, /Bot permissions are not involved/,
    'it has to say so outright, because the last message said the opposite');
  assert.ok(!/MANAGE ROLES/i.test(note), 'and must not mention them otherwise');
});

test('the lookup failure is logged rather than swallowed', () => {
  // It was silent. Three members vanished from the run with no line naming
  // them, and the only output was the wrong explanation underneath.
  const fn = syncTierRoles();
  assert.match(fn, /missing \+= 1;\s*\n\s*console\.warn\(`  could not look up \$\{m\.discord_id\}/,
    'the member who could not be looked up is named in the log');
});

test('the summary counts both kinds separately', () => {
  const fn = syncTierRoles();
  assert.match(fn, /\$\{missing\} not in the server/);
  assert.match(fn, /\$\{refused\} refused by Discord/);
});
