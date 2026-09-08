-- What a hunter is going to play next, chosen by them.
--
-- THE ONE LIST ON THIS BOARD THAT IS TYPED IN RATHER THAN SCANNED, and that is
-- deliberate rather than a gap. Everything else here is a fact PSN reported:
-- what somebody owns, what they earned, when. What they INTEND to play next is
-- not a fact about the past and no API can be asked for it.
--
-- Two of the three lists a streamer usually maintains by hand already exist for
-- free and truer: "playing" is member_games with progress between 1 and 99, and
-- "played" is progress = 100. This is the third, and the only one that needs a
-- person.
--
-- WHAT MAKES IT WORTH HAVING is what sits beside each row rather than the row
-- itself. A wishlist is a list; a wishlist where every game carries what it
-- pays on this board, how many of us own it and how many have finished it is a
-- pitch. That is the column no other trophy site can print.
--
-- np_comm_id, NOT A TITLE. A pin on the overlay taught this: "God of War" does
-- not say which of three trophy lists, and a list that is ambiguous about which
-- edition is a list nobody can price.
--
-- NO ORDERING COLUMN. The panel shows it newest first, which is the ordering
-- somebody adding a game actually expects, and a hand-sorted list is one more
-- thing to keep current. If voting ever lands, the votes do the ordering.
--
-- Run once against the live database:
--   Cloudflare dashboard, D1, platinum-intel, Console. Paste and run.

CREATE TABLE IF NOT EXISTS wishlist (
  psn_account_id TEXT    NOT NULL,
  np_comm_id     TEXT    NOT NULL,
  added_at       INTEGER NOT NULL,
  PRIMARY KEY (psn_account_id, np_comm_id)
);

-- The panel asks for one hunter's list, newest first, and nothing else ever
-- asks this table anything.
CREATE INDEX IF NOT EXISTS idx_wishlist_member
  ON wishlist(psn_account_id, added_at DESC);
