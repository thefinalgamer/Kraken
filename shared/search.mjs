/**
 * Turning a game title into something a person can actually type.
 *
 * THE REPORT. PrimalxFear, 14 November: *"I noticed that you need to type
 * special characters when searching a game like Far Cry 6. if you search Far
 * Cry 6 you cannot find the game. is there a way to fix this so it searches
 * without special characters?"*
 *
 * He is right, and it is wider than the one symbol. Search was
 * `title LIKE '%far cry 6%'` against a stored `Far Cry(R) 6`, and the (R) sits
 * between "Cry" and " 6", so the substring never matches. Nothing was broken in
 * the query. The title simply has a character in it that nobody types.
 *
 * HOW WIDE. Measured before building, across 26,504 games:
 *
 *   3,899  a colon            979  a straight apostrophe
 *     565  (TM)               386  (R)
 *     348  a full stop        283  an ampersand
 *     129  a comma             66  fullwidth digits or letters
 *      48  a curly apostrophe  32  an en or em dash
 *
 * 3,030 of the 9,787 games on the index page carry at least one of them. A
 * third of what you can browse was unreachable by typing its name.
 *
 * BOTH APOSTROPHES ARE IN USE, which is the detail that makes a hand-written
 * fix hopeless: we hold `Assassin's Creed` and `Uncharted 4: A Thief(curly)s
 * End`, so whichever one a member types, half the library stays hidden.
 *
 * WHY A STORED COLUMN rather than cleaning the title inside the query. D1's
 * SQLite has no Unicode case folding, no accent handling and no regex, so the
 * query version is a ten-deep stack of nested REPLACE repeated at all eight
 * places that search a title, and it still could not do accents, fullwidth
 * digits or the Roman numerals below. `games.title_search` holds the output of
 * this function; see migration 043.
 *
 * IT IS NOT AN INDEX. `title_search LIKE '%x%'` scans the table exactly as
 * `title LIKE '%x%'` did. This buys correctness, not speed, and costs none
 * either.
 */

/**
 * The typed form of a title: lower case, no decoration, single spaces.
 *
 * Run over BOTH sides of the comparison. The stored title becomes a key when it
 * is written, and whatever the member typed becomes one before it is bound, so
 * the two meet in the middle and neither side has to be spelled the hard way.
 *
 * The order of the steps matters and each one is load-bearing:
 */
export const searchKey = (s) =>
  String(s ?? '')
    /*
     * (R), (TM) and (C) FIRST, and they become a GAP rather than nothing.
     *
     * A gap because the symbol is often the only thing between two words:
     * `EA SPORTS(TM)UFC(R)3` has no spaces at all, and deleting the marks
     * gives "easportsufc3", which is no more typeable than what we started
     * with. As a space it reads "ea sports ufc 3".
     *
     * First because NFKC below would otherwise turn (TM) into the letters
     * "tm", and `DARK SOULS(TM): REMASTERED` would key as "dark souls tm
     * remastered" -- still unfindable by anybody searching for it.
     */
    .replace(/[®™©℗℠]/g, ' ')
    /*
     * Compatibility forms to their plain equivalents: fullwidth digits and
     * letters to ASCII (66 titles), and the single-character Roman numerals to
     * ordinary letters.
     *
     * That last one is a genuine find. `DARK SOULS(TM) II: Scholar of the
     * First Sin` does not contain two capital i's; it contains U+2161, the
     * single character numeral. 17 games do this, and searching "dark souls
     * ii" has never once worked.
     */
    .normalize('NFKC')
    /*
     * Accents off, but ONLY on Latin runs.
     *
     * Decomposing the whole string and dropping the combining marks is the
     * obvious way to turn `Ghost of Yotei` (stored with a macron) into
     * something typeable, and it works. It also strips the dakuten off
     * Japanese kana, which turns the perfectly good title マブラヴ into
     * マフラウ: a different word, matching nothing a reader would type.
     * Caught in testing, hence the narrower sweep.
     */
    .replace(/\p{Script=Latin}+/gu, (run) =>
      run.normalize('NFD').replace(/[̀-ͯ]/g, ''),
    )
    .toLowerCase()
    /*
     * These VANISH instead of becoming a gap, which is the opposite of the
     * trademark rule above and deliberately so.
     *
     * Apostrophes: `Marvel's Spider-Man` has to key as "marvels", because
     * "marvel s" is not what anybody types and not what anybody expects.
     * Full stops and commas come along for the ride and pay for themselves:
     * `F.E.A.R. 2` keys as "fear 2", and `Warhammer 40,000` as
     * "warhammer 40000", both of which are what people actually write.
     */
    .replace(/['‘’ʼ´`.,]/g, '')
    /*
     * Everything else that is not a letter or a number is a gap: colons,
     * dashes, ampersands, underscores, bullets, slashes, and the stray
     * newlines that 35 titles turn out to carry (`√Letter` is stored with
     * one on the end).
     *
     * \p{L} is every script's letters, so Japanese, Korean and Chinese titles
     * keep their characters and stay searchable in their own alphabet.
     */
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * The bound value for a `title_search LIKE ? ESCAPE '\'` fragment.
 *
 * THE ESCAPE IS A BELT, NOT THE BRACES. searchKey() already leaves nothing but
 * letters, numbers and single spaces, so the three characters LIKE treats as
 * special cannot reach this line: a member typing "100%" searches for "100".
 * It stays because it costs nothing and because it is the one thing standing
 * between a future edit to the sweep above and a search for "_" quietly
 * returning all 26,504 games.
 *
 * Returns '' for a term that normalises away to nothing, for example a search
 * made entirely of punctuation. Callers treat that as no search at all rather
 * than as `%%`, which would also return the whole table.
 */
export const searchTerm = (q) => {
  const key = searchKey(q);
  if (!key) return '';
  return `%${key.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
};

/**
 * The `WHERE` fragment that matches a title, and the arguments for it.
 *
 * ONE DEFINITION, EIGHT CALL SITES. The games index, the hunter profile and its
 * missing-games lookup, and five autocompletes in the bot all used to carry
 * their own copy of `title LIKE ?`. Three of them had slightly different rules
 * about case and empty boxes, which is how search came to behave differently
 * depending on which box you typed into.
 *
 * WHY THE SECOND ARM. `title_search IS NULL` means migration 043 has run but
 * `npm run backfill-search` has not, and on that database the first arm matches
 * nothing at all. Falling back to the old raw-title comparison means the gap
 * between pushing and running the backfill looks exactly like today rather than
 * like a search box that returns nothing for everybody. Once the backfill has
 * run the second arm is dead weight that never fires, and it costs nothing to
 * leave it there for the next database that gets built from scratch.
 *
 * @param {string} prefix table alias and dot, for example 'g.', or '' for none
 */
export const titleMatchSql = (prefix = '') =>
  `(${prefix}title_search LIKE ? ESCAPE '\\'` +
  ` OR (${prefix}title_search IS NULL AND ${prefix}title LIKE ? ESCAPE '\\' COLLATE NOCASE))`;

/** A LIKE term from a raw string, escaped but NOT normalised. The fallback arm. */
const rawLike = (q, wrap) => {
  const s = String(q ?? '').replace(/[\\%_]/g, (c) => `\\${c}`);
  return wrap === 'starts' ? `${s}%` : `%${s}%`;
};

/**
 * Arguments for titleMatchSql: anywhere in the title.
 *
 * THE ESCAPING IS NEW ON THE RAW ARM and fixes a small old bug of its own. The
 * bot's autocompletes bound `%${query}%` with no ESCAPE clause, so a member
 * typing a single `%` into /game matched every game on the server.
 */
export const titleContains = (q) => [searchTerm(q), rawLike(q, 'contains')];

/** Arguments for titleMatchSql: the title STARTS with it. Used for ranking. */
export const titleStartsWith = (q) => {
  const key = searchKey(q);
  return [key ? `${key.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : '', rawLike(q, 'starts')];
};
