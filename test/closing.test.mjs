import test from 'node:test';
import assert from 'node:assert/strict';
import {
  closingState, daysLeft, closingLabel, parseClosingDate, isUrgent,
  DEAD, CLOSING, FINE, DAY_MS,
} from '../shared/closing.mjs';

const NOW = Date.UTC(2026, 7, 28, 12, 0, 0); // 28 Aug 2026, midday

test('dead, dying and fine are three different things', () => {
  assert.equal(closingState({ unobtainable: 1 }, NOW), DEAD);
  assert.equal(closingState({ closes_at: NOW + 20 * DAY_MS }, NOW), CLOSING);
  assert.equal(closingState({ closes_at: NOW - DAY_MS }, NOW), DEAD, 'a passed date is dead');
  assert.equal(closingState({}, NOW), FINE);
  assert.equal(closingState({ closes_at: null }, NOW), FINE);
});

test('a human flag beats a date', () => {
  // A mod has looked at the game. A date is a prediction somebody typed weeks
  // ago, possibly before the closure was delayed.
  assert.equal(closingState({ unobtainable: 1, closes_at: NOW + 500 * DAY_MS }, NOW), DEAD);
});

test('days left round up, so the last day still counts', () => {
  assert.equal(daysLeft(NOW + 0.5 * DAY_MS, NOW), 1, 'half a day left is still a day');
  assert.equal(daysLeft(NOW + 9.2 * DAY_MS, NOW), 10);
  assert.equal(daysLeft(NOW - 1, NOW), 0);
  assert.equal(daysLeft(null, NOW), 0);
});

test('urgency has a floor and a ceiling', () => {
  assert.equal(isUrgent(NOW + 5 * DAY_MS, NOW), true);
  assert.equal(isUrgent(NOW + 29 * DAY_MS, NOW), true);
  assert.equal(isUrgent(NOW + 120 * DAY_MS, NOW), false, 'four months is not urgent');
  assert.equal(isUrgent(NOW - DAY_MS, NOW), false, 'already gone is not urgent');
});

test('the wording changes with the distance, because the feeling does', () => {
  assert.equal(closingLabel(NOW + 0.2 * DAY_MS, NOW), 'closes tomorrow');
  assert.equal(closingLabel(NOW + 12 * DAY_MS, NOW), 'closes in 12 days');
  // Past ninety days a countdown stops meaning anything and a date starts to.
  assert.match(closingLabel(NOW + 400 * DAY_MS, NOW), /^closes on \d+ \w+ \d{4}$/);
  assert.equal(closingLabel(NOW - DAY_MS, NOW), 'closed');
  assert.equal(closingLabel(null, NOW), '');
});

test('the date field is strict, and says why when it refuses', () => {
  const ok = parseClosingDate('2027-03-15', NOW);
  assert.equal(ok.ok, true);
  // End of the named day, not the start: a server closing "on the 15th" is up
  // for all of the 15th.
  assert.equal(ok.at, Date.UTC(2027, 2, 15) + DAY_MS - 1);

  for (const bad of ['March', '15/03/2027', '2027-3-15', 'soon', 'next spring']) {
    const r = parseClosingDate(bad, NOW);
    assert.equal(r.ok, false, `${bad} should be rejected`);
    assert.match(r.reason, /YYYY-MM-DD/);
  }
});

test('a date that does not exist is refused rather than rolled over', () => {
  // Date.UTC turns 31 February into 3 March without complaint, which would be a
  // silently wrong countdown rather than an error.
  const r = parseClosingDate('2027-02-31', NOW);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no 2027-02-31/);
});

test('past dates and typo years are refused', () => {
  const past = parseClosingDate('2020-01-01', NOW);
  assert.equal(past.ok, false);
  assert.match(past.reason, /already dead/);

  const far = parseClosingDate('2099-01-01', NOW);
  assert.equal(far.ok, false);
  assert.match(far.reason, /ten years/);
});

test('an empty date is not an error, it is no date', () => {
  // Clearing a closure has to be possible, and must not read as a failure.
  assert.deepEqual(parseClosingDate('', NOW), { ok: true, at: null });
  assert.deepEqual(parseClosingDate(null, NOW), { ok: true, at: null });
});
