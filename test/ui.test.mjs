import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tierFor, trend, flag, ordinal, memberCard, configureEmoji,
} from '../shared/ui.mjs';

test('tiers hold up at every server size', () => {
  // Two members, the state right now
  assert.equal(tierFor(1, 2), 'platinum');
  assert.equal(tierFor(2, 2), 'gold');

  // Three hundred, the target
  assert.equal(tierFor(1, 300), 'platinum');
  assert.equal(tierFor(2, 300), 'gold');
  assert.equal(tierFor(30, 300), 'gold');
  assert.equal(tierFor(31, 300), 'silver');
  assert.equal(tierFor(99, 300), 'silver');
  assert.equal(tierFor(100, 300), 'bronze');
  assert.equal(tierFor(300, 300), 'bronze');
});

test('there is exactly one platinum, always', () => {
  for (const total of [1, 2, 5, 50, 300, 1000]) {
    const plats = Array.from({ length: total }, (_, i) => tierFor(i + 1, total))
      .filter((t) => t === 'platinum').length;
    assert.equal(plats, 1, `${total} members should yield one platinum`);
  }
});

test('tiers never invert — a better rank is never a worse tier', () => {
  const order = { platinum: 0, gold: 1, silver: 2, bronze: 3 };
  for (const total of [10, 50, 300]) {
    let last = -1;
    for (let r = 1; r <= total; r++) {
      const v = order[tierFor(r, total)];
      assert.ok(v >= last, `rank ${r}/${total} went backwards`);
      last = v;
    }
  }
});

test('trend arrows', () => {
  assert.equal(trend(1, 3), ' ▲2');
  assert.equal(trend(5, 2), ' ▼3');
  assert.equal(trend(4, 4), '');
  assert.equal(trend(4, null), '');
});

test('flags', () => {
  assert.equal(flag('GB'), '🇬🇧');
  assert.equal(flag('ca'), '🇨🇦');
  assert.equal(flag(null), '');
  assert.equal(flag('XXX'), '');
});

test('ordinals survive the awkward numbers', () => {
  assert.equal(ordinal(1), '1st');
  assert.equal(ordinal(2), '2nd');
  assert.equal(ordinal(3), '3rd');
  assert.equal(ordinal(11), '11th');
  assert.equal(ordinal(12), '12th');
  assert.equal(ordinal(13), '13th');
  assert.equal(ordinal(21), '21st');
  assert.equal(ordinal(112), '112th');
});

test('member card respects Discord component limits', () => {
  const card = memberCard(
    {
      discord_id: '1', psn_online_id: 'th3finalgamer--', country: 'GB',
      rank: 1, prev_rank: 3, platinum: 212, gold: 944, silver: 2232,
      bronze: 7534, completion: 70.22, points: 137474, avatar_url: null,
    },
    { total: 2 },
  );

  const section = card.components.find((c) => c.type === 9);
  assert.ok(section, 'card should contain a Section');
  assert.ok(
    section.components.length <= 3,
    `Section accepts 1-3 components, got ${section.components.length} — ` +
      'Discord rejects the whole message and the member sees "did not respond in time"',
  );
  assert.ok(section.components.length >= 1);

  // Container: max 10 children
  assert.ok(card.components.length <= 10);

  // 4000 characters across all TextDisplays in a message
  const chars = JSON.stringify(card).length;
  assert.ok(chars < 4000, `card is ${chars} chars`);
});

test('every tier renders without throwing', () => {
  for (const total of [1, 2, 30, 300]) {
    for (const rank of [1, 2, 15, 50, 299]) {
      if (rank > total) continue;
      const card = memberCard(
        { discord_id: 'x', psn_online_id: 'someone', country: null, rank,
          prev_rank: null, platinum: 1, gold: 2, silver: 3, bronze: 4,
          completion: 50, points: 100, avatar_url: null },
        { total },
      );
      const section = card.components.find((c) => c.type === 9);
      assert.ok(section.components.length <= 3, `rank ${rank}/${total}`);
      assert.ok(typeof card.accent_color === 'number');
    }
  }
});
