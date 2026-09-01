/**
 * Rivals: up to five hunters you want to keep an eye on.
 *
 * The list lives in one text column as a JSON array of psn_account_id. This
 * file is the only place that knows that, so the shape can change without
 * hunting through the Worker.
 *
 * EVERY READ IS DEFENSIVE. The column is text written by a previous version of
 * this code, and a member's rivals list is a decoration on a card — a row that
 * cannot be parsed must render as "no rivals yet", never as an error. The board
 * itself has to keep working for somebody whose list got mangled.
 */

/**
 * FIVE, and the number is doing real work.
 *
 * A watchlist you have to think about is a watchlist worth having. Twenty
 * rivals is a second leaderboard, and the whole point of this feature is that
 * it is NOT the leaderboard — it is the three or four people you are actually
 * racing. The cap forces the choice that makes the list mean something.
 */
export const MAX_RIVALS = 5;

/** The stored column, as an array of account ids. Never throws. */
export function parseRivals(raw) {
  if (!raw) return [];
  try {
    const ids = JSON.parse(raw);
    if (!Array.isArray(ids)) return [];
    // Strings only, de-duplicated, capped. A list that grew past the cap in an
    // older build is truncated on read rather than rejected.
    return [...new Set(ids.filter((v) => typeof v === 'string' && v))].slice(0, MAX_RIVALS);
  } catch {
    return [];
  }
}

/** Back to the column. Kept symmetrical with parseRivals on purpose. */
export const serialiseRivals = (ids) =>
  JSON.stringify([...new Set(ids.filter(Boolean))].slice(0, MAX_RIVALS));

/**
 * @returns {{ ids: string[], error: string|null }}
 *
 * The rules live here rather than in the command handler, so the same answers
 * come back however this is called and every one of them can be tested without
 * a Discord interaction.
 */
export function addRival(current, accountId, { self = null, name = 'They' } = {}) {
  const ids = parseRivals(JSON.stringify(current));
  if (!accountId) return { ids, error: 'I could not find that hunter on the board.' };
  if (self && accountId === self) {
    return { ids, error: 'You are already on your own list. That is what the top row is.' };
  }
  if (ids.includes(accountId)) return { ids, error: `${name} is already one of your rivals.` };
  if (ids.length >= MAX_RIVALS) {
    return {
      ids,
      error:
        `You already have ${MAX_RIVALS} rivals, which is the limit. ` +
        'Drop one with `/rivals remove` and the new one will fit.',
    };
  }
  return { ids: [...ids, accountId], error: null };
}

export function removeRival(current, accountId, { name = 'They' } = {}) {
  const ids = parseRivals(JSON.stringify(current));
  if (!accountId || !ids.includes(accountId)) {
    return { ids, error: `${name} is not on your list.` };
  }
  return { ids: ids.filter((id) => id !== accountId), error: null };
}
