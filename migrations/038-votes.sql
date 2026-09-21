-- Votes. The streamer runs /vote start in Discord, viewers vote on the Twitch
-- panel, the streamer runs /vote end when they are ready.
--
-- NO TIMER, on Martin's word: a vote stays open until the streamer closes it.
-- The winner does NOT go onto the overlay by itself either, because people
-- often vote on the NEXT stream. It is posted, and the streamer runs /setgame
-- when they actually start it.
--
-- `options` is a JSON array of np_comm_ids, frozen at the moment the vote
-- opened, so editing the list mid-vote cannot move the ballot under anybody.
-- `source` is list, backlog or random.
--
-- One ballot per Twitch viewer per vote, enforced by the primary key. `voter`
-- is Twitch's opaque user id for the extension, which is stable for a logged-in
-- viewer and says nothing about who they are. Logged-out viewers cannot vote.
--
-- Unlinking a member deletes their votes, ballots and backlog with them.

CREATE TABLE IF NOT EXISTS votes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  psn_account_id TEXT    NOT NULL,
  source         TEXT    NOT NULL,
  options        TEXT    NOT NULL,
  opened_at      INTEGER NOT NULL,
  closed_at      INTEGER,
  winner         TEXT,
  total          INTEGER
);

-- The panel asks "this member's latest vote" on every refresh.
CREATE INDEX IF NOT EXISTS idx_votes_member ON votes(psn_account_id, opened_at DESC);

CREATE TABLE IF NOT EXISTS vote_ballots (
  vote_id    INTEGER NOT NULL,
  voter      TEXT    NOT NULL,
  np_comm_id TEXT    NOT NULL,
  cast_at    INTEGER NOT NULL,
  PRIMARY KEY (vote_id, voter)
);

-- The tally is a GROUP BY over one vote's ballots, which the primary key
-- already serves. No second index.

-- The backlog: games a streamer wants chat to help them clear, for streamers
-- with no request system. Separate from the wishlist on purpose.
CREATE TABLE IF NOT EXISTS vote_backlog (
  psn_account_id TEXT    NOT NULL,
  np_comm_id     TEXT    NOT NULL,
  added_at       INTEGER NOT NULL,
  PRIMARY KEY (psn_account_id, np_comm_id)
);
