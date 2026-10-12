/**
 * Completion — the multiplier on everyone's score — computed from the database.
 *
 * ONE definition, used by both the scan and the rescore. They used to be able
 * to disagree: the scan derived completion from PSN's title list while the
 * rescore couldn't derive it at all, so the board's most important number
 * depended on which job ran last. Now both call this.
 *
 * THE RULE (Martin, 19 August 2026): a game worth zero points does not count
 * toward completion, in either direction.
 *
 *   "buying games or playing new games shouldn't help your % up — you should
 *    always need to be pushed to do your backlog"
 *
 * Why it matters. Completion multiplies your entire score, and shovelware is
 * trivially 100%-able, so finishing cheap games was the fastest way to raise
 * everything you own. The size of the hole, measured: LucasDiasC's worthless
 * games weigh 4.8x his entire real library. Put that pile on RabbitSquared, who
 * sits at 47.98% on real games, and he goes to 91% — nearly doubling his score
 * without earning a single rarity point.
 *
 * It cuts both ways, which is what makes it fair rather than a patch. Martin's
 * own 91 abandoned shovelware games were dragging his percentage DOWN; they now
 * count for nothing in that direction too. A worthless game is worthless.
 *
 * Cost, accepted knowingly: the figure no longer exactly matches PSNProfiles,
 * who count everything. JFL__Leon noticed the last time the two disagreed.
 *
 * AND THE SECOND RULE (Martin, 12 October 2026): a game you have never earned
 * a trophy in does not count either, in either direction.
 *
 *   "0% games shouldnt effect you i agree, regardless if people move or not it
 *    shouldnt be a thing"
 *
 * PrimalxFear found why it has to be a rule rather than a preference. Owning a
 * game you have not touched LOWERED your completion, and completion multiplies
 * your whole score, so deleting one paid - which PSN allows precisely because
 * you have earned nothing in it. His worked example:
 *
 *   "say the seasonal is about to begin, i start 20 games before it start at 0%
 *    and get my completion rate down. Then when it starts i delete those games
 *    and BOOM 1st place because i got points."
 *
 * Nobody was doing it. 780 rows out of 76,634 were never-started, spread across
 * ordinary backlogs, and the heaviest holders were small libraries rather than
 * anyone circling a season. But a board with a start date hands that strategy a
 * reason to exist, and seasons are on the list.
 *
 * Same shape as the rule above and the same justification: a game that has
 * given you nothing takes nothing. The test is `earned_total > 0` rather than a
 * percentage, because PSN's progress is weighted - one bronze in a ninety
 * trophy list still reads as 0% - and going by the percentage would punish
 * exactly the people this protects.
 *
 * The 90/30/15 weights, and the platinum's absence, are `completionWeight()` in
 * shared/scoring.mjs — see there for why a platinum scores zero. If you change
 * them, change them here too.
 */
export const COMPLETION_SQL = `
  SELECT
    COALESCE(SUM(mg.earned_gold * 90 + mg.earned_silver * 30 + mg.earned_bronze * 15), 0) AS earned,
    COALESCE(SUM(g.completion_weight), 0) AS defined
  FROM member_games mg
  JOIN games g ON g.np_comm_id = mg.np_comm_id
  WHERE mg.psn_account_id = ?
    AND g.max_points > 0
    AND mg.earned_total > 0
`;

/**
 * @returns {Promise<{completion:number, earned:number, defined:number}>}
 *   completion as a percentage, FLOORED to two places — never rounded, or
 *   somebody sitting at 99.996% is told by their own leaderboard that they have
 *   finished.
 */
export async function memberCompletion(db, accountId) {
  const row = (await db.one(COMPLETION_SQL, [accountId])) ?? { earned: 0, defined: 0 };
  const earned = Number(row.earned) || 0;
  const defined = Number(row.defined) || 0;
  const raw = defined ? (earned / defined) * 100 : 0;
  return { completion: Math.floor(raw * 100) / 100, earned, defined };
}
