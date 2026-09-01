import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * The d20 throw, checked as arithmetic rather than by watching it.
 *
 * This animation has been wrong twice and both times it was hard to describe:
 * "it kinda streches and jumps". Frame captures of a CSS animation are flaky
 * and slow, and neither fault was visible in a single frame anyway — they were
 * faults in the RELATIONSHIP between keyframes. So the keyframes are parsed and
 * the physics is asserted directly, which is exact, instant, and says which
 * number is wrong when it fails.
 *
 * The model, in one line: a thrown die keeps its horizontal speed while it is
 * airborne and loses a share of it at each impact. Nothing else.
 */
const css = await readFile(new URL('../functions/_lib/page.js', import.meta.url), 'utf8');

const frames = (name) => {
  const i = css.indexOf(`@keyframes ${name}{`);
  assert.ok(i > -1, `@keyframes ${name} is missing`);
  return css.slice(i, css.indexOf('\n}', i));
};

/**
 * One entry per keyframe stop: `{ at, body }`.
 *
 * Split on the stop markers rather than reaching across the block with a lazy
 * match. The first version did the latter and the `8%` stop, which sets only
 * opacity, quietly swallowed the rotation belonging to `26%` — so the test
 * compared seven stops, thought that was fine, and would have gone on passing
 * with a wrong number in the one keyframe it skipped.
 */
const stopsOf = (name) => {
  const body = frames(name);
  const out = [];
  const re = /(\d+(?:\.\d+)?)%\s*\{/g;
  let m;
  const marks = [];
  while ((m = re.exec(body))) marks.push([parseFloat(m[1]), m.index + m[0].length]);
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? body.lastIndexOf('%', marks[i + 1][1]) : body.length;
    out.push({ at: marks[i][0], body: body.slice(marks[i][1], end) });
  }
  return out;
};

const TRAVEL = 72;   // vw, right edge to rest
const PER_VW = 25;   // degrees of roll per vw travelled

const vwIn = (chunk) => {
  const m = chunk.match(/translate3d\((-?\d+(?:\.\d+)?)vw/);
  return m ? parseFloat(m[1]) : null;
};
const degIn = (chunk) => {
  const m = chunk.match(/rotate3d\([\d.,]+,(-?\d+)deg/);
  return m ? parseFloat(m[1]) : null;
};

const xStops = stopsOf('throwx').map((k) => [k.at, vwIn(k.body)]);

test('the die never speeds up after a bounce', () => {
  /**
   * THE BUG THIS EXISTS FOR. Horizontal and vertical shared one transform, so
   * the ease-out that decelerates the die as it RISES was also slowing its
   * travel across the screen. The keyframes had been fudged to compensate and
   * the fudge overshot: the die moved 21% faster just after the first bounce
   * than it did falling in. That speed-up is what read as a jump.
   */
  let previous = Infinity;
  for (let i = 1; i < xStops.length; i++) {
    const speed = (xStops[i - 1][1] - xStops[i][1]) / (xStops[i][0] - xStops[i - 1][0]);
    assert.ok(
      speed <= previous + 0.01, // tolerance is rounding of the vw values, nothing more
      `speeds up at ${xStops[i][0]}%: ${speed.toFixed(3)} after ${previous.toFixed(3)} vw/%`,
    );
    assert.ok(speed >= 0, `travels backwards at ${xStops[i][0]}%`);
    previous = speed;
  }
});

test('the roll is a function of distance, not of time', () => {
  /**
   * What "rolling" means: it turns BECAUSE it is moving. Keyframing rotation
   * independently is how the first attempt ended up crossing a third of the
   * screen while barely turning and then spinning on the spot.
   */
  const byTime = Object.fromEntries(xStops);
  const rolls = stopsOf('throwy')
    .map((k) => [k.at, degIn(k.body)])
    .filter(([, deg]) => deg !== null);

  let checked = 0;
  for (const [t, deg] of rolls) {
    if (byTime[t] === undefined) continue;      // the settle keyframe has no x stop
    // `+ 0` normalises negative zero: at 0% the die has travelled nothing, so
    // the expected rotation is -0, and assert.equal uses Object.is, which holds
    // that -0 is not 0.
    const want = -Math.round((TRAVEL - byTime[t]) * PER_VW) + 0;
    assert.equal(deg, want, `rotation is off at ${t}%`);
    checked += 1;
  }
  assert.ok(checked >= 8, `only ${checked} stops compared`);
});

test('it comes to rest on a whole number of turns', () => {
  // Otherwise it stops mid-tumble on an edge, and the faces it was lit for are
  // pointing somewhere else.
  const last = [...frames('throwy').matchAll(/rotate3d\([\d.,]+,(-?\d+)deg/g)].pop();
  assert.equal(Math.abs(Number(last[1])) % 360, 0, 'lands part-way through a turn');
  assert.equal(Math.abs(Number(last[1])), TRAVEL * PER_VW, 'and exactly what the distance owes');
});

test('it settles rather than stopping dead', () => {
  // The one thing a physical object never does is halt on a frame. It rocks a
  // few degrees past and rolls back onto the face.
  const body = frames('throwy');
  assert.match(body, /97\.5%/, 'there is a keyframe after the last bounce');
  assert.match(body, /-1804deg/, 'which overshoots');
  assert.ok(body.trimEnd().endsWith('-1800deg)}'), 'and comes back to rest');
});

test('the shadow is under the die at every shared keyframe', () => {
  // When these drifted apart the die appeared to skate: shadow in one place,
  // object in another, which reads as broken long before anybody can say why.
  const byTime = Object.fromEntries(xStops);
  const shadow = stopsOf('landshadow').map((k) => [k.at, vwIn(k.body)]);

  assert.ok(shadow.length >= 9, 'the shadow has its own stops');
  for (const [t, v] of shadow) {
    if (byTime[t] === undefined) continue;
    assert.ok(Math.abs(byTime[t] - v) < 0.01, `shadow is adrift at ${t}%: ${v} vs ${byTime[t]}`);
  }
});

test('the travel track carries no rotation of its own', () => {
  /**
   * A second rotation axis was added here to make the die tumble. It made it
   * fly: the perspective lives on .d20, so a child translated most of a screen
   * from the perspective origin is viewed increasingly off-axis, and pitching it
   * through that skewed frustum reads as banking rather than rolling.
   * One axis, on one element. This is the assertion that stops it coming back.
   */
  assert.ok(!/rotate/.test(frames('throwx')), 'travel is translation only');
});

test('travel and bounce live on different elements', () => {
  /**
   * The structural fix, asserted structurally. One transform cannot ease
   * horizontal travel and vertical bouncing differently, and that is exactly
   * what produced the lurch. If these two ever collapse back onto one element,
   * the arithmetic tests above go on passing while the motion is wrong again.
   */
  assert.match(css, /\.rolled \.dscale\{animation:throwx/, 'travel is on the scaler');
  assert.match(css, /\.rolled \.dspin\{animation:throwy/, 'bounce and roll are on the spinner');

  const x = frames('throwx');
  assert.ok(!/-?\d+px/.test(x), 'the travel track carries no vertical movement');
  const y = frames('throwy');
  assert.ok(!/vw/.test(y), 'and the bounce track carries no travel');
});

test('reduced motion stops every part of it, including the new one', () => {
  // A die that is supposed to sit still must not travel 72vw anyway, and
  // .dscale carries the SIZE as well as the travel, so turning its animation
  // off has to restore the scale by hand.
  const i = css.indexOf('@media (prefers-reduced-motion:reduce){\n  /* The die still arrives');
  assert.ok(i > -1, 'the reduced-motion block is still there');
  const block = css.slice(i, css.indexOf('\n}', i));
  for (const sel of ['.rolled .dscale', '.rolled .dspin', '.rolled .d20::after']) {
    assert.ok(block.includes(sel), `${sel} keeps animating under reduced motion`);
  }
  assert.match(block, /\.rolled \.dscale\{transform:scale\(1\)\}/, 'and the die keeps its size');
});

test('there is exactly one definition of the throw', () => {
  /**
   * There were two: a 1.9s cubic-bezier block and a 2s linear one, the later
   * silently winning. An edit to the wrong copy would have changed nothing and
   * been very hard to explain.
   */
  assert.equal((css.match(/\.rolled \.dspin\{animation:/g) || []).length, 1);
  assert.equal((css.match(/@keyframes throwy\{/g) || []).length, 1);
  assert.equal((css.match(/@keyframes landshadow\{/g) || []).length, 1);
});

test('the keyframe parser sees every stop, including the ones with no transform', () => {
  /**
   * The reason this test exists: the first parser reached across keyframes with
   * a lazy match, so `8%` (opacity only) absorbed the rotation belonging to
   * `26%`. Seven stops got compared instead of nine and nothing complained.
   * A parser that silently skips input makes every assertion built on it a
   * decoration.
   */
  const y = stopsOf('throwy');
  assert.deepEqual(y.map((k) => k.at), [0, 8, 26, 38, 52, 63, 75, 84, 94, 97.5, 100]);

  const opacityOnly = y.find((k) => k.at === 8);
  assert.equal(degIn(opacityOnly.body), null, '8% carries no rotation of its own');
  assert.match(opacityOnly.body, /opacity:1/, 'only the fade-in');

  assert.deepEqual(stopsOf('throwx').map((k) => k.at), [0, 26, 38, 52, 63, 75, 84, 94, 100]);
  assert.equal(stopsOf('landshadow').length, 10);
});
