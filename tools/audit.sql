/*
   Board audit: every invariant the code believes, asked of the live database.

   Paste the whole thing into the D1 console. One row per check, and a zero in
   the "wrong" column is the answer you want. Anything else, run the drill-down
   for that check (tools/audit-drilldown.sql) to see which rows.

   RUN IT AFTER A NIGHTLY RESCORE. The rescore is what re-totals prices, so a
   run before it reports work that was already scheduled to happen.

   It reads a lot of rows by design. One run costs roughly what a busy hour of
   the site does, so it is not something to leave on a schedule.

   Block comments, not double-dash ones, and no semicolons inside them. A paste
   into the D1 console can arrive as a single line, and a double-dash comment
   then swallows the entire query. That has happened once already.
*/

SELECT 'games priced in two currencies' AS check_name,
       COUNT(*) AS wrong,
       'header total disagrees with the sum of its trophies (the FFXV bug)' AS what_it_means
  FROM games g
 WHERE g.max_points <> (SELECT COALESCE(SUM(t.points), 0)
                          FROM trophies t WHERE t.np_comm_id = g.np_comm_id)

UNION ALL
SELECT 'games whose size we have wrong',
       COUNT(*),
       'trophy_count disagrees with the rows we hold, so percentages are off'
  FROM games g
 WHERE g.trophy_count <> (SELECT COUNT(*) FROM trophies t WHERE t.np_comm_id = g.np_comm_id)
   AND EXISTS (SELECT 1 FROM trophies t WHERE t.np_comm_id = g.np_comm_id)

UNION ALL
SELECT 'owned games missing trophy names',
       COUNT(DISTINCT g.np_comm_id),
       'a DLC arrived and the names were never fetched'
  FROM games g
  JOIN trophies t ON t.np_comm_id = g.np_comm_id
 WHERE g.local_started > 0 AND t.name IS NULL

UNION ALL
SELECT 'owned games missing pack ids',
       COUNT(DISTINCT g.np_comm_id),
       'trophies with no group, so DLC shows as base game'
  FROM games g
  JOIN trophies t ON t.np_comm_id = g.np_comm_id
 WHERE g.local_started > 0 AND t.group_id IS NULL

UNION ALL
SELECT 'DLC packs with no name',
       COUNT(*),
       'the page heads these "DLC 5" instead of what the console calls them'
  FROM (SELECT DISTINCT t.np_comm_id, t.group_id
          FROM trophies t
          JOIN games g ON g.np_comm_id = t.np_comm_id
         WHERE t.group_id IS NOT NULL AND t.group_id <> 'default'
           AND g.local_started > 0
           AND NOT EXISTS (SELECT 1 FROM trophy_groups tg
                            WHERE tg.np_comm_id = t.np_comm_id
                              AND tg.group_id = t.group_id))

UNION ALL
SELECT 'progress outside 0-100',
       COUNT(*),
       'PSN overshoot that migration 032 should have cleaned up'
  FROM member_games WHERE progress > 100 OR progress < 0

UNION ALL
SELECT 'earned_total disagrees with earned_ids',
       COUNT(*),
       'the stored count and the stored list are different lengths'
  FROM member_games
 WHERE earned_ids IS NOT NULL
   AND json_valid(earned_ids)
   AND earned_total <> json_array_length(earned_ids)

UNION ALL
SELECT 'members whose raw total is not the sum of their games',
       COUNT(*),
       'members.raw_points drifted from member_games.points'
  FROM members m
 WHERE m.last_update_at IS NOT NULL
   AND m.raw_points <> (SELECT COALESCE(SUM(mg.points), 0)
                          FROM member_games mg
                         WHERE mg.psn_account_id = m.psn_account_id)

UNION ALL
SELECT 'members whose score is not raw x completion',
       COUNT(*),
       'points should be raw_points times the completion they are PAID at'
  FROM members m
 WHERE m.last_update_at IS NOT NULL
   AND m.points <> CAST(m.raw_points * CAST(m.completion AS INTEGER) / 100 AS INTEGER)

UNION ALL
SELECT 'games counted by nobody but owned by somebody',
       COUNT(*),
       'local_started is 0 while member_games says otherwise'
  FROM games g
 WHERE g.local_started = 0
   AND EXISTS (SELECT 1 FROM member_games mg WHERE mg.np_comm_id = g.np_comm_id)

UNION ALL
SELECT 'trophies held by more people than own the game',
       COUNT(*),
       'local_earned above local_started, which cannot happen'
  FROM trophies t
  JOIN games g ON g.np_comm_id = t.np_comm_id
 WHERE t.local_earned > g.local_started

UNION ALL
SELECT 'worth something but counts for no completion',
       COUNT(*),
       'max_points above zero with completion_weight of zero'
  FROM games
 WHERE max_points > 0 AND completion_weight = 0

UNION ALL
SELECT 'trophy log rows with no trophy',
       COUNT(*),
       'member_trophies pointing at definitions we do not have'
  FROM member_trophies mt
 WHERE NOT EXISTS (SELECT 1 FROM trophies t
                    WHERE t.np_comm_id = mt.np_comm_id AND t.trophy_id = mt.trophy_id)

ORDER BY wrong DESC;
