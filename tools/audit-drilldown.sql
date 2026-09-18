/*
   Drill-downs for tools/audit.sql. Run ONE of these, the one whose count came
   back non-zero. Each returns the offending rows, worst first.
*/

/* 1. Games priced in two currencies (the FFXV bug). */
SELECT g.title, g.platform, g.local_started AS owners,
       g.max_points AS header_says,
       (SELECT COALESCE(SUM(t.points), 0) FROM trophies t WHERE t.np_comm_id = g.np_comm_id) AS trophies_say
  FROM games g
 WHERE g.max_points <> (SELECT COALESCE(SUM(t.points), 0) FROM trophies t WHERE t.np_comm_id = g.np_comm_id)
 ORDER BY g.local_started DESC, ABS(g.max_points - (SELECT COALESCE(SUM(t.points), 0) FROM trophies t WHERE t.np_comm_id = g.np_comm_id)) DESC
 LIMIT 30;

/* 2. Games whose stored size disagrees with the rows we hold. */
SELECT g.title, g.platform, g.local_started AS owners, g.trophy_count AS we_think,
       (SELECT COUNT(*) FROM trophies t WHERE t.np_comm_id = g.np_comm_id) AS we_hold
  FROM games g
 WHERE EXISTS (SELECT 1 FROM trophies t WHERE t.np_comm_id = g.np_comm_id)
   AND g.trophy_count <> (SELECT COUNT(*) FROM trophies t WHERE t.np_comm_id = g.np_comm_id)
 ORDER BY g.local_started DESC LIMIT 30;

/* 3/4. Owned games missing names or pack ids. Run backfill-names to fix. */
SELECT g.title, g.platform, g.local_started AS owners,
       SUM(CASE WHEN t.name IS NULL THEN 1 ELSE 0 END)     AS missing_names,
       SUM(CASE WHEN t.group_id IS NULL THEN 1 ELSE 0 END) AS missing_groups
  FROM games g JOIN trophies t ON t.np_comm_id = g.np_comm_id
 WHERE g.local_started > 0
 GROUP BY g.np_comm_id
HAVING missing_names > 0 OR missing_groups > 0
 ORDER BY g.local_started DESC LIMIT 30;

/* 5. DLC packs with no name. Also backfill-names. */
SELECT g.title, t.group_id, COUNT(*) AS trophies, g.local_started AS owners
  FROM trophies t JOIN games g ON g.np_comm_id = t.np_comm_id
 WHERE t.group_id IS NOT NULL AND t.group_id <> 'default' AND g.local_started > 0
   AND NOT EXISTS (SELECT 1 FROM trophy_groups tg
                    WHERE tg.np_comm_id = t.np_comm_id AND tg.group_id = t.group_id)
 GROUP BY t.np_comm_id, t.group_id
 ORDER BY g.local_started DESC LIMIT 30;

/* 6. Progress outside 0-100. Migration 032 clamps these. */
SELECT m.psn_online_id, g.title, mg.progress, mg.earned_total, g.trophy_count
  FROM member_games mg
  JOIN members m ON m.psn_account_id = mg.psn_account_id
  JOIN games   g ON g.np_comm_id = mg.np_comm_id
 WHERE mg.progress > 100 OR mg.progress < 0
 ORDER BY mg.progress DESC LIMIT 30;

/* 7. earned_total disagrees with the stored list of ids. */
SELECT m.psn_online_id, g.title, mg.earned_total AS count_says,
       json_array_length(mg.earned_ids) AS list_says
  FROM member_games mg
  JOIN members m ON m.psn_account_id = mg.psn_account_id
  JOIN games   g ON g.np_comm_id = mg.np_comm_id
 WHERE mg.earned_ids IS NOT NULL AND json_valid(mg.earned_ids)
   AND mg.earned_total <> json_array_length(mg.earned_ids)
 ORDER BY ABS(mg.earned_total - json_array_length(mg.earned_ids)) DESC LIMIT 30;

/* 8/9. Members whose totals do not add up. A rescore rewrites both. */
SELECT m.psn_online_id, m.rank, m.completion,
       m.raw_points AS raw_says,
       (SELECT COALESCE(SUM(mg.points), 0) FROM member_games mg
         WHERE mg.psn_account_id = m.psn_account_id) AS games_say,
       m.points AS score_says,
       CAST(m.raw_points * CAST(m.completion AS INTEGER) / 100 AS INTEGER) AS score_should_be
  FROM members m
 WHERE m.last_update_at IS NOT NULL
   AND (m.raw_points <> (SELECT COALESCE(SUM(mg.points), 0) FROM member_games mg
                          WHERE mg.psn_account_id = m.psn_account_id)
        OR m.points <> CAST(m.raw_points * CAST(m.completion AS INTEGER) / 100 AS INTEGER))
 ORDER BY m.rank LIMIT 30;

/* 10/11. Local counts that cannot be true. countLocalRarity in the rescore owns these. */
SELECT g.title, g.local_started AS owners_recorded,
       (SELECT COUNT(*) FROM member_games mg WHERE mg.np_comm_id = g.np_comm_id) AS owners_actual,
       (SELECT MAX(t.local_earned) FROM trophies t WHERE t.np_comm_id = g.np_comm_id) AS most_held_by
  FROM games g
 WHERE g.local_started <> (SELECT COUNT(*) FROM member_games mg WHERE mg.np_comm_id = g.np_comm_id)
    OR EXISTS (SELECT 1 FROM trophies t WHERE t.np_comm_id = g.np_comm_id AND t.local_earned > g.local_started)
 ORDER BY owners_actual DESC LIMIT 30;

/* 12. Worth points but counts for no completion. */
SELECT title, platform, max_points, trophy_count, local_started AS owners
  FROM games WHERE max_points > 0 AND completion_weight = 0
 ORDER BY local_started DESC, max_points DESC LIMIT 30;

/* 13. Trophy log rows pointing at definitions we do not have. */
SELECT m.psn_online_id, mt.np_comm_id, mt.trophy_id,
       DATETIME(mt.earned_at/1000, 'unixepoch') AS earned,
       (SELECT title FROM games g WHERE g.np_comm_id = mt.np_comm_id) AS title
  FROM member_trophies mt
  JOIN members m ON m.psn_account_id = mt.psn_account_id
 WHERE NOT EXISTS (SELECT 1 FROM trophies t
                    WHERE t.np_comm_id = mt.np_comm_id AND t.trophy_id = mt.trophy_id)
 ORDER BY mt.earned_at DESC LIMIT 30;
