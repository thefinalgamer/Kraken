/*
   Board audit: every invariant the code believes, asked of the live database.

   THREE separate queries. Paste ONE at a time into the D1 console and run it.
   A zero in the "wrong" column is the answer you want for every row.
   Anything else, run that check's drill-down in tools/audit-drilldown.sql.

   RUN IT AFTER A NIGHTLY RESCORE. The rescore is what re-totals prices, so a
   run before it reports work that was already scheduled to happen.

   What each check means:
     1  header total disagrees with the sum of its trophies (the FFXV bug)
     2  trophy_count disagrees with the rows we hold, so percentages are off
     3  a DLC arrived and the trophy names were never fetched
     4  trophies with no pack id, so DLC shows as base game
     5  packs the page heads "DLC 5" instead of what the console calls them
     6  PSN progress overshoot that migration 032 should have cleaned up
     7  earned_total and the stored list of ids are different lengths
     8  members.raw_points drifted from the sum of member_games.points
     9  points should be raw_points times the completion they are PAID at
    10  local_started is 0 while member_games says somebody owns it
    11  local_earned above local_started, which cannot happen
    12  max_points above zero with completion_weight of zero
    13  member_trophies pointing at definitions we do not have
    14  rows with no name, no pack, no value and nobody holding them. PSN
        dropped the trophy and we kept the row, which is what Warhawk did
        to two people's completion. Migration 034 clears them.

   Two rules for this file, both learned the hard way.

   Block comments, never double-dash ones, and no semicolon inside one. A paste
   into the D1 console can arrive as a single line, and a double-dash comment
   then swallows the entire query.

   Short statements. The console truncated a 4,000 character paste at about
   2,100 and answered "incomplete input", which is why the audit is split in
   three rather than run as one.

   It reads a lot of rows by design. One full pass costs roughly what a busy
   hour of the site does, so it is not something to leave on a schedule.
*/

/* Checks 1 to 4 - the games table against the trophies we hold. */
SELECT '1 two currencies' AS chk, COUNT(*) AS wrong FROM games g WHERE g.max_points<>(SELECT COALESCE(SUM(t.points),0) FROM trophies t WHERE t.np_comm_id=g.np_comm_id)
UNION ALL
SELECT '2 wrong trophy count',COUNT(*) FROM games g WHERE g.trophy_count<>(SELECT COUNT(*) FROM trophies t WHERE t.np_comm_id=g.np_comm_id) AND EXISTS(SELECT 1 FROM trophies t WHERE t.np_comm_id=g.np_comm_id)
UNION ALL
SELECT '3 missing names',COUNT(DISTINCT g.np_comm_id) FROM games g JOIN trophies t ON t.np_comm_id=g.np_comm_id WHERE g.local_started>0 AND t.name IS NULL
UNION ALL
SELECT '4 missing pack ids',COUNT(DISTINCT g.np_comm_id) FROM games g JOIN trophies t ON t.np_comm_id=g.np_comm_id WHERE g.local_started>0 AND t.group_id IS NULL;

/* Checks 5 to 8 - packs, progress, and member totals. */
SELECT '5 unnamed packs',COUNT(*) FROM (SELECT DISTINCT t.np_comm_id,t.group_id FROM trophies t JOIN games g ON g.np_comm_id=t.np_comm_id WHERE t.group_id IS NOT NULL AND t.group_id<>'default' AND g.local_started>0 AND NOT EXISTS(SELECT 1 FROM trophy_groups tg WHERE tg.np_comm_id=t.np_comm_id AND tg.group_id=t.group_id))
UNION ALL
SELECT '6 progress out of range',COUNT(*) FROM member_games WHERE progress>100 OR progress<0
UNION ALL
SELECT '7 count vs list',COUNT(*) FROM member_games WHERE earned_ids IS NOT NULL AND json_valid(earned_ids) AND earned_total<>json_array_length(earned_ids)
UNION ALL
SELECT '8 raw total drift',COUNT(*) FROM members m WHERE m.last_update_at IS NOT NULL AND m.raw_points<>(SELECT COALESCE(SUM(mg.points),0) FROM member_games mg WHERE mg.psn_account_id=m.psn_account_id);

/* Checks 9 to 14 - scores, local counts, the trophy log, and dead rows. */
SELECT '9 score not raw x completion',COUNT(*) FROM members m WHERE m.last_update_at IS NOT NULL AND m.points<>CAST(m.raw_points*CAST(m.completion AS INTEGER)/100 AS INTEGER)
UNION ALL
SELECT '10 owned but uncounted',COUNT(*) FROM games g WHERE g.local_started=0 AND EXISTS(SELECT 1 FROM member_games mg WHERE mg.np_comm_id=g.np_comm_id)
UNION ALL
SELECT '11 earned above owned',COUNT(*) FROM trophies t JOIN games g ON g.np_comm_id=t.np_comm_id WHERE t.local_earned>g.local_started
UNION ALL
SELECT '12 priced but weightless',COUNT(*) FROM games WHERE max_points>0 AND completion_weight=0
UNION ALL
SELECT '13 log rows with no trophy',COUNT(*) FROM member_trophies mt WHERE NOT EXISTS(SELECT 1 FROM trophies t WHERE t.np_comm_id=mt.np_comm_id AND t.trophy_id=mt.trophy_id)
UNION ALL
SELECT '14 unusable trophy rows',COUNT(*) FROM trophies WHERE name IS NULL AND group_id IS NULL AND COALESCE(points,0)=0 AND COALESCE(local_earned,0)=0;
