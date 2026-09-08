import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { bodyOf } from './helpers.mjs';

/**
 * The wishlist.
 *
 * THE ONE LIST ON THIS BOARD SOMEBODY TYPES. Everything else is scanned: what a
 * hunter owns, what they earned, when. What they INTEND to play next is not a
 * fact about the past and no API can be asked for it.
 *
 * Which makes the interesting question not "does it store a row" but "is a row
 * worth reading". A list of game names is a list; a list where every game
 * carries what it pays on this board, how many of us own it and how many have
 * finished it is a pitch, and that is the column nothing else on the internet
 * has. Most of what is checked here is that the column survives.
 */

const SRC = await readFile(new URL('../worker/src/index.mjs', import.meta.url), 'utf8');
const fn = (() => {
  const at = SRC.indexOf('async function wishlist');
  const end = SRC.indexOf('async function ', at + 10);
  const body = SRC.slice(at, end === -1 ? undefined : end);
  assert.ok(body.length > 1500, 'the slice covers the command');
  return body;
})();

test('the list is capped, and the cap is the point', () => {
  /**
   * Twelve is a plan. Fifty is a library, and a Twitch panel 318 pixels wide
   * can show neither the fifty nor a reason to care about any of them.
   */
  assert.match(SRC, /const WISHLIST_MAX = 12;/);
  assert.match(fn, /rows\.length >= WISHLIST_MAX/, 'checked before adding');
  assert.match(fn, /Take one off/, 'and it says what to do about it');
});

test('a game is identified by np_comm_id, never by title', async () => {
  /**
   * The lesson the overlay pin taught: "God of War" does not say which of three
   * trophy lists, and a list that is ambiguous about the edition is a list
   * nobody can price.
   */
  assert.match(fn, /db\.gameById\(env, wanted\)/, 'looked up as an id');
  assert.match(fn, /Pick a game from the dropdown/, 'and typed input is refused');

  const reg = await readFile(
    new URL('../jobs/register-commands.mjs', import.meta.url), 'utf8',
  );
  /**
   * Comments stripped first. The very next command's comment EXPLAINS that it
   * carries no `default_member_permissions`, and a guard that cannot tell an
   * explanation from the thing it explains fails on the reasoning - which is
   * the third time that has happened in this repo.
   */
  const code = reg
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const block = code.slice(code.indexOf("name: 'wishlist'"), code.indexOf("name: 'setgame'"));
  assert.match(block, /name: 'add'/);
  assert.match(block, /name: 'remove'/);
  assert.equal((block.match(/autocomplete: true/g) || []).length, 2, 'both fields pick');
  assert.ok(!/default_member_permissions/.test(block), 'and it is not mod only');
});

test('adding replies with the pitch, not a receipt', () => {
  // "Added" tells them nothing they did not already know. What it is worth here
  // and how many of us are already in it is the reason the list exists.
  assert.match(fn, /points at 100%/);
  assert.match(fn, /of us own it/);
  assert.match(fn, /nobody here owns it yet/, 'and the lonely case reads as English');
});

test('adding the same game twice is refused, not duplicated', () => {
  // Re-running a command after a Discord timeout is the most ordinary thing in
  // the world and must be harmless.
  assert.match(fn, /already on your list/);
});

test('add and remove in one command is refused rather than half done', () => {
  // The same class of bug parseClosingDate refuses a bad date for: somebody
  // believes they did two things and finds out later they did one.
  assert.match(fn, /One at a time/);
});

test('a missing migration is named, not printed as SQLite', () => {
  assert.match(fn, /030-wishlist/);
  // Every path that touches the table has to be covered, not just the first.
  assert.ok((fn.match(/isMissing\(err\)/g) || []).length >= 3, 'read, add and remove');
});

test('the add picker searches the catalogue, the remove picker searches their list', async () => {
  /**
   * A game you do not own yet is the most natural thing to put on a list of
   * what you will play next, so `add` looks at the catalogue. Offering the
   * catalogue to REMOVE from would be offering an error message.
   */
  const auto = SRC.slice(SRC.indexOf('async function handleAutocomplete'));
  assert.match(auto, /isWishAdd[\s\S]{0,400}searchGamesForWish/);
  assert.match(auto, /isWishDrop[\s\S]{0,400}db\.wishlist\(env, me\.psn_account_id\)/);

  const dbSrc = await readFile(new URL('../worker/src/db.mjs', import.meta.url), 'utf8');
  const q = dbSrc.slice(dbSrc.indexOf('export const searchGamesForWish'));
  assert.match(q.slice(0, 900), /local_started > 0/, 'the catalogue search stays bounded');
  assert.match(q.slice(0, 900), /np_comm_id/, 'and returns ids, not titles');
});

// ------------------------------------------------------- the hunter page ---

const hunter = await import('../functions/hunter/[name].js');

const MEMBER = {
  psn_account_id: 'a1', psn_online_id: 'JFL__Leon', country: 'GB', avatar_url: null,
  rank: 31, prev_rank: 31, points: 184751, reported_points: 184751, completion: 70.9,
  platinum: 214, gold: 960, silver: 2278, bronze: 7634, projects: 314, completed: 158,
  last_update_at: Date.now(), supporter_months: 0, rivals: null,
};

const WISH = [{
  np_comm_id: 'NPWR_SH2', title: 'SILENT HILL 2', platform: 'PS5', icon_url: null,
  max_points: 4200, local_started: 3, unobtainable: 0, closes_at: null,
  finished_here: 0, my_progress: null,
}, {
  np_comm_id: 'NPWR_BB', title: 'Bloodborne', platform: 'PS4', icon_url: null,
  max_points: 1847, local_started: 6, unobtainable: 0, closes_at: null,
  finished_here: 2, my_progress: 41,
}];

const env = (wishes) => ({
  DB: {
    prepare(sql) {
      const answer = () => {
        if (sql.includes('FROM wishlist')) return { all: async () => ({ results: wishes }) };
        if (sql.includes('FROM members')) {
          if (sql.includes('COUNT(*)')) return { first: async () => ({ c: 75 }) };
          if (sql.includes('ORDER BY rank ASC')) return { all: async () => ({ results: [] }) };
          if (!sql.includes('rivals')) return { first: async () => null, all: async () => ({ results: [] }) };
          return { first: async () => MEMBER, all: async () => ({ results: [MEMBER] }) };
        }
        return { first: async () => null, all: async () => ({ results: [] }) };
      };
      return { ...answer(), bind: () => answer() };
    },
  },
});

const page = async (wishes) => {
  const res = await hunter.onRequestGet({
    params: { name: 'JFL__Leon' },
    env: env(wishes),
    request: new Request('https://kraken.test/hunter/JFL__Leon'),
  });
  return bodyOf(await res.text());
};

test('every row on the page carries its price and the local column', async () => {
  const body = await page(WISH);

  assert.match(body, /SILENT HILL 2/);
  assert.match(body, /4,200/, 'what it pays here');
  assert.match(body, /3 of us own it, none finished/, 'and who else is in it');
  assert.match(body, /6 of us own it, 2 finished/);
  assert.match(body, /41%/, 'plus how far in they already are');
});

test('an empty list teaches the command rather than saying nothing', async () => {
  // The person looking at an empty state has just gone looking for the thing,
  // which makes it the best place on the site to explain a feature.
  const body = await page([]);
  assert.match(body, /Playing next/);
  assert.match(body, /wishlist add/);
  assert.match(body, /pays on this board/);
});

test('a database without the table still renders the page', async () => {
  const broken = {
    DB: {
      prepare(sql) {
        const answer = () => {
          if (sql.includes('FROM wishlist')) {
            return { all: async () => { throw new Error('no such table: wishlist'); } };
          }
          if (sql.includes('FROM members')) {
            if (sql.includes('COUNT(*)')) return { first: async () => ({ c: 75 }) };
            if (sql.includes('ORDER BY rank ASC')) return { all: async () => ({ results: [] }) };
            if (!sql.includes('rivals')) return { first: async () => null, all: async () => ({ results: [] }) };
            return { first: async () => MEMBER, all: async () => ({ results: [MEMBER] }) };
          }
          return { first: async () => null, all: async () => ({ results: [] }) };
        };
        return { ...answer(), bind: () => answer() };
      },
    },
  };
  const res = await hunter.onRequestGet({
    params: { name: 'JFL__Leon' },
    env: broken,
    request: new Request('https://kraken.test/hunter/JFL__Leon'),
  });
  assert.equal(res.status, 200, 'a decoration must not be able to take the page down');
  assert.match(bodyOf(await res.text()), /Playing next/);
});
