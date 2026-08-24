-- 009 — what the member was last TOLD
--
-- Martin: "if wilko lost 3 points it should still say he lost that much."
--
-- He was right that it wasn't being said, and the cause is here. The update
-- card computes its delta as (now - members.points), but the rescore job also
-- writes members.points — so anything the rescore changed between two updates
-- is already baked into the "before" side and cancels itself out. Wilko lost
-- three points to Martin's Black Flag session, the rescore banked it, and his
-- next update correctly computed a difference of zero.
--
-- Every cross-member effect in the scoring model lands this way. Local rarity
-- moves everyone's score whenever anybody plays, which is the entire point of
-- layer two, and none of it was visible to anyone.
--
-- The fix is to separate two things that were being conflated:
--
--   members.points            what you are worth NOW  (rescore owns this)
--   members.reported_points   what we last SHOWED you (updates own this)
--
-- The card then diffs against what it last told the member, so anything that
-- happened in between — rescores, other people's scans, a scoring change —
-- shows up on the next update instead of vanishing. It needs no new arithmetic:
-- explainDelta() already buckets exactly this as `drift`, because it is the
-- part of the change that new trophies do not explain.
--
-- NULL means "never reported" and falls back to the live value, so existing
-- members see no phantom jump on their first update after this lands.
--
-- Run one at a time. "duplicate column" means that step is already done.

ALTER TABLE members ADD COLUMN reported_points INTEGER;
ALTER TABLE members ADD COLUMN reported_raw_points INTEGER;
ALTER TABLE members ADD COLUMN reported_completion REAL;
