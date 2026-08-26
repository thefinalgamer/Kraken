import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tierFor, trend, flag, ordinal, memberCard, configureEmoji,
  chaseLine, lastSeen, rarestLine, pct,
  boardBlocks, blockChars, chunkBoard, text, row, button, updateCard,
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
  // The arrows are custom emoji now — Discord cannot colour text, so a green
  // up and a red down have to be images. Assert on the movement rather than
  // the glyph, so re-uploading the emoji never breaks the suite.
  assert.match(trend(1, 3), /up.*2$/);
  assert.match(trend(5, 2), /down.*3$/);
  assert.equal(trend(4, 4), '');
  assert.equal(trend(4, null), '');
});

test('chase line', () => {
  const me = { points: 226198 };
  assert.match(chaseLine(me, { points: 367581, psn_online_id: 'JFL__Leon' }), /141,383.*JFL__Leon/);
  assert.equal(chaseLine(me, null), '');
  // A tie, or somebody below you, gets no line rather than "0 behind".
  assert.equal(chaseLine(me, { points: 226198, psn_online_id: 'x' }), '');
});

test('last seen', () => {
  const now = Date.parse('2026-08-17T22:00:00Z');
  const ago = (mins) => now - mins * 60000;
  assert.equal(lastSeen(ago(1), now), 'updated just now');
  assert.equal(lastSeen(ago(30), now), 'updated 30 minutes ago');
  assert.equal(lastSeen(ago(60 * 5), now), 'updated 5 hours ago');
  assert.equal(lastSeen(ago(60 * 24 * 3), now), 'updated 3 days ago');
  assert.equal(lastSeen(null, now), '');
});

test('rarest line', () => {
  assert.equal(
    rarestLine({ rarest_name: 'The Path Home', rarest_rate: 0.31 }),
    '◆ The Path Home · 0.31%',
  );
  // Unrated trophies come back as 0.00% and must never win this contest.
  assert.equal(rarestLine({ rarest_name: 'Ghost', rarest_rate: 0 }), '');
  assert.equal(rarestLine({}), '');
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

test('configureEmoji keeps emoji it does not know about', () => {
  // Regression: it used to rebuild the set from a fixed list of keys, which
  // silently dropped the trend arrows and rendered them as "undefined".
  configureEmoji({ EMOJI_PLATINUM: '<:p:1>' });
  assert.match(trend(1, 3), /up|▲/);
  assert.doesNotMatch(trend(1, 3), /undefined/);
  assert.doesNotMatch(trend(5, 2), /undefined/);
});

test('percentages round down, never up', () => {
  // The case that matters: someone a few trophies short of everything must
  // never be shown 100%.
  assert.equal(pct(99.996), '99.99%');
  assert.equal(pct(74.999), '74.99%');
  assert.equal(pct(49.201), '49.20%');
  assert.equal(pct(100), '100.00%');
  assert.equal(pct(0), '0.00%');
});

test('the board stays inside Discord limits at any size', () => {
  // Regression: cards broke the board the day a fifth member joined. Discord
  // counts nested components against a limit of 40, and a card is 8 of them.
  // A tier block is 3, however many people are in it.
  const count = (c) => {
    let n = 0;
    const walk = (x) => {
      if (Array.isArray(x)) return x.forEach(walk);
      if (x && typeof x === 'object' && typeof x.type === 'number') {
        n++;
        Object.values(x).forEach(walk);
      }
    };
    walk(c);
    return n;
  };

  const make = (size) =>
    Array.from({ length: size }, (_, i) => ({
      rank: i + 1,
      prev_rank: i + 2,
      psn_online_id: 'AVeryLongPsnName_XX',
      discord_id: String(i),
      points: 900000 - i * 137,
      completion: 99.99 - i / 10,
    }));

  // One message's worth, at every plausible server size.
  for (const total of [5, 25, 100, 300]) {
    const page = make(Math.min(25, total));
    const msg = [
      text('# Platinum Intel'),
      ...boardBlocks(page, { total, viewerId: '3' }),
      row(button('a', '1'), button('b', '2'), button('c', '3')),
    ];
    assert.ok(count(msg) <= 40, `${total} members: ${count(msg)} components`);
    assert.ok(
      blockChars(msg) < 4000,
      `${total} members: ${blockChars(msg)} characters — every row carries a 30-character emoji id`,
    );
  }

  // And the whole board splits into whole messages with nobody lost.
  const everyone = make(137);
  const chunks = chunkBoard(everyone);
  assert.equal(chunks.flat().length, 137);
  assert.equal(chunks[0][0].rank, 1);
});

// ------------------------------------------------- earned nothing, gained ---

test('a trophy that scores zero is not "you earned nothing"', () => {
  // JFL__Leon, Update No. 409: one bronze on Sea of Thieves, +1,587 points, and
  // the card told him he had earned nothing. He had — it just scored zero,
  // because over half of PlayStation has that trophy. True arithmetic, false
  // sentence.
  const card = updateCard({
    member: { discord_id: '1', psn_online_id: 'JFL__Leon' },
    updateNo: 409,
    before: { platinum: 5, gold: 20, silver: 40, bronze: 300, completion: 61.2, projects: 90, completed: 30 },
    after:  { platinum: 5, gold: 20, silver: 40, bronze: 301, completion: 61.21, projects: 90, completed: 30 },
    delta: { earned: 0, backlog: 0, drift: 1587, net: 1587 },
    gamesChanged: 1,
    durationSeconds: 14,
  });
  const out = JSON.stringify(card);

  assert.doesNotMatch(out, /You earned nothing this session and gained anyway/);
  assert.match(out, /The trophy you earned is common enough to score nothing/);
  assert.match(out, /more than half of PlayStation/);
  assert.match(out, /came from the server instead/);
});

test('somebody who really did earn nothing is still told so', () => {
  const card = updateCard({
    member: { discord_id: '1', psn_online_id: 'YT-WilkoX' },
    updateNo: 410,
    before: { platinum: 2, gold: 8, silver: 12, bronze: 90, completion: 44, projects: 30, completed: 9 },
    after:  { platinum: 2, gold: 8, silver: 12, bronze: 90, completion: 44, projects: 30, completed: 9 },
    delta: { earned: 0, backlog: 0, drift: -3, net: -3 },
    gamesChanged: 0,
    durationSeconds: 9,
  });
  const out = JSON.stringify(card);

  assert.match(out, /You earned nothing this session and the number still moved/);
  assert.match(out, /Nothing was taken away/);
});

test('several zero-scoring trophies read as plural', () => {
  const card = updateCard({
    member: { discord_id: '1', psn_online_id: 'Pelziowo' },
    updateNo: 411,
    before: { platinum: 0, gold: 0, silver: 0, bronze: 100, completion: 30, projects: 500, completed: 400 },
    after:  { platinum: 0, gold: 0, silver: 2, bronze: 104, completion: 30, projects: 500, completed: 400 },
    delta: { earned: 0, backlog: 0, drift: 40, net: 40 },
    gamesChanged: 2,
    durationSeconds: 20,
  });
  assert.match(JSON.stringify(card), /Your 6 trophies are common enough to score nothing/);
});
