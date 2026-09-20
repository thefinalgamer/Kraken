/*
   Games a member holds trophies in that PSN has stopped returning.

   Paste into the D1 console. One row per game, longest-missing first.

   WHAT IT IS FOR. PSN lets a member hide a trophy list, and a hidden list is
   not returned by the API, so from our side it looks like the game vanished.
   Somebody sitting on a 40% game they would rather nobody saw can hide it and
   watch their PlayStation completion rise.

   IT GAINS THEM NOTHING ON THIS BOARD. The scan only ever removes a row with
   nothing earned in it, so a hidden game keeps its row and keeps counting in
   both halves of their completion. Their PSN profile moves, their Kraken score
   does not. This is not a hole being plugged, it is a thing being made visible.

   READ THE "days" COLUMN, NOT THE FACT THAT IT IS LISTED. A list can stop
   coming back for reasons nobody chose: Sony delisted Warhawk's three operation
   packs outright, regional stacks get restructured, and one short PSN response
   drops things too. A game gone sixteen days is a decision. A game gone one day
   is probably Sony. The date is the evidence, the listing is not.

   It fills itself in as scans run. A game that comes back has its date cleared
   on the next scan, so an empty result means nothing is currently missing
   rather than that nothing ever was.

   Needs migration 036. Before that has run, this errors on hidden_at and the
   scan quietly records nothing.
*/

SELECT m.psn_online_id AS hunter,
       g.title,
       mg.progress || '%' AS was_at,
       mg.earned_total || '/' || g.trophy_count AS trophies,
       DATE(mg.hidden_at / 1000, 'unixepoch') AS gone_since,
       CAST((strftime('%s', 'now') * 1000 - mg.hidden_at) / 86400000 AS INTEGER) AS days
  FROM member_games mg
  JOIN members m ON m.psn_account_id = mg.psn_account_id
  JOIN games   g ON g.np_comm_id = mg.np_comm_id
 WHERE mg.hidden_at IS NOT NULL
 ORDER BY mg.hidden_at ASC;
