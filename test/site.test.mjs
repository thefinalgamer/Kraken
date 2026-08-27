import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The board page, rendered against fake rows.
 *
 * No database and no network: onRequestGet() takes its env as an argument, so a
 * four-line stub stands in for D1. That keeps these fast enough to run on every
 * deploy, which is the only reason they will still be running in six months.
 *
 * The two that matter most are the last ones. A PSN online ID is attacker-
 * controlled text from Sony that we paste into HTML, and an avatar URL goes
 * straight into an attribute. Both are escaped, and both are pinned here.
 */
const mod = await import('../functions/index.js');

const fakeEnv = (rows) => ({ DB: { prepare: () => ({ all: async () => ({ results: rows }) }) } });
const render = async (rows) => {
  const res = await mod.onRequestGet({ env: fakeEnv(rows) });
  return { res, out: await res.text() };
};

const members = [
  { rank:1, prev_rank:2, psn_online_id:'Pelziowo', country:'PL', avatar_url:null, points:1204551, completion:41.09, platinum:1210, gold:900, silver:2100, bronze:11000, projects:15411, completed:9002 },
  { rank:2, prev_rank:1, psn_online_id:'N7_Maxxi', country:'DE', avatar_url:null, points:693771, completion:74.5, platinum:129, gold:400, silver:900, bronze:3000, projects:350, completed:301 },
  { rank:3, prev_rank:3, psn_online_id:'th3finalgamer--', country:'GB', avatar_url:null, points:123210, completion:74.996, platinum:88, gold:200, silver:500, bronze:1800, projects:297, completed:138 },
  { rank:4, prev_rank:9, psn_online_id:'JFL_Leon', country:'AU', avatar_url:null, points:99210, completion:61.21, platinum:60, gold:150, silver:400, bronze:1200, projects:132, completed:118 },
];

test('the board renders every hunter, cached and escaped', async () => {
  const { res, out } = await render(members);

  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type'), /text\/html/);
  assert.match(res.headers.get('Cache-Control'), /max-age=300/);

  for (const m of members) assert.ok(out.includes(m.psn_online_id), `${m.psn_online_id} missing`);
  assert.ok(out.includes('🇬🇧') && out.includes('🇵🇱'), 'country flags');
  assert.ok(out.includes('>1st<') && out.includes('>4th<'), 'ordinals');
  assert.match(out, /Pelziowo[\s\S]{0,400}Platinum/, 'first place is Platinum');
  assert.ok(out.includes('▲5'), 'Leon climbed 5');
  assert.ok(out.includes('▼1'), 'Maxxi fell 1');
  assert.ok(out.includes('1,204,551'), 'points are grouped');
  assert.ok(out.includes('data-v="1204551"'), 'numeric sort key present');
  assert.equal((out.match(/>Platinum</g) || []).length, 1, 'exactly one Platinum');
});

test('percentages are floored, never rounded up', async () => {
  // 74.996% must print 74.99%. Rounding shows somebody a milestone they have
  // not reached, and disagrees with the number Discord shows them.
  const { out } = await render(members);
  assert.ok(out.includes('74.99%'));
  assert.ok(!out.includes('75.00%'));
});

test('a hostile PSN name cannot inject markup', async () => {
  const { out } = await render([{ ...members[0], psn_online_id: '<img src=x onerror=alert(1)>' }]);
  assert.ok(out.includes('&lt;img'), 'escaped');
  assert.ok(!out.includes('<img src=x'), 'not rendered as a tag');
});

test('a hostile avatar url cannot break out of its attribute', async () => {
  const { out } = await render([{ ...members[0], avatar_url: '" onerror="alert(1)' }]);
  assert.ok(!out.includes('onerror="alert'));
});

test('an empty board says so rather than rendering nothing', async () => {
  const { out } = await render([]);
  assert.ok(out.includes('Nobody has finished a scan yet'));
});

/**
 * The bioluminescence at the foot of the page.
 *
 * DETERMINISM IS THE POINT. These responses sit in Cloudflare's edge cache, and
 * a page whose HTML differs on every request is one that can never be diffed,
 * compared or trusted. Math.random would have looked identical in a screenshot
 * and been wrong in a way nothing would ever have caught.
 */
test('the deep is decorative, deterministic and out of the way', async () => {
  const a = await render(members);
  const b = await render(members);
  assert.equal(a.out, b.out, 'two renders of the same data are byte-identical');

  assert.ok(a.out.includes('<div class="deep" aria-hidden="true">'), 'the layer exists');
  assert.ok(a.out.includes('aria-hidden="true"'), 'and is hidden from screen readers');
  assert.equal((a.out.match(/<i style="--sz:/g) || []).length, 44, 'forty-four motes');

  // It must never sit in front of a word or eat a click.
  assert.ok(a.out.includes('pointer-events:none'), 'cannot intercept clicks');
  assert.ok(a.out.includes('prefers-reduced-motion:reduce'), 'motion can be turned off');
});

test('the Discord link is real, external and safe', async () => {
  const { out } = await render(members);
  assert.ok(out.includes('https://discord.com/invite/gdSqDYrXaH'), 'the invite');
  assert.ok(out.includes('rel="noopener noreferrer"'), 'no window.opener handle back to us');

  // The pages that do not exist are still labels, not links that 404.
  assert.ok(out.includes('<span class="soon" title="Coming soon">Games</span>'));
  assert.ok(out.includes('<span class="soon" title="Coming soon">Contested</span>'));
});

test('the logo is the artwork, not an emoji, and doubles as the favicon', async () => {
  const { out } = await render(members);
  assert.ok(out.includes('<img src="/Kraken.png" alt="" width="60" height="60">'), 'header mark');
  assert.ok(out.includes('<link rel="icon" href="/Kraken.png"'), 'favicon');
  assert.ok(!out.includes('🐙'), 'the placeholder emoji is gone');

  // width and height are on the tag on purpose: without them the header jumps
  // when the image lands, which is the cheapest layout shift there is to avoid.
  assert.ok(out.includes('width="60" height="60"'));
});

test('trophies drift up with the light, but only a few', async () => {
  const { out } = await render(members);
  assert.equal((out.match(/<i style="--sz:/g) || []).length, 44, 'motes');
  assert.equal((out.match(/<b style="--sz:/g) || []).length, 6, 'trophies');
  // The joke only works if you catch it. Twenty would read as clip art.
});

test('the site says plainly that it is not Sony', async () => {
  const { out } = await render(members);
  assert.match(out, /not affiliated with,[\s\S]*endorsed by or connected to Sony or PlayStation/);
});
