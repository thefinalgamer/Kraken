-- 009 — what we last TOLD you, as distinct from what you are worth
--
-- The update card diffed against members.points. The rescore job also writes
-- members.points. So anything the rescore changed between two updates was
-- already baked into the "before" side of the subtraction and cancelled itself
-- out — and every cross-member effect reaches the board through the rescore.
--
-- Martin earned eight trophies on a game YT-WilkoX owns. Local rarity correctly
-- took three points off Wilko. His next /update said "Points: 0". The number
-- was right; the question was wrong.
--
-- Which means layer two — the entire economy, the thing the board exists for —
-- has been running invisibly since the day it shipped.
--
--   members.points            what you are worth NOW   (the rescore owns this)
--   members.reported_points   what we last SHOWED you  (updates own this)
--
-- The card diffs against the second, so anything that happened in between
-- surfaces on the next update. explainDelta() already buckets "the part new
-- trophies do not explain" as drift, which is exactly what somebody else's
-- play is — so there is no new arithmetic, only a corrected question.
--
-- NULL means never reported, and the scan falls back to the live value. So
-- nobody currently on the board sees a phantom jump on their first update after
-- this lands; they miss one session's drift, which beats inventing history
-- nobody recorded.
--
-- RUN THIS BEFORE PUSHING THE CODE. Backwards is survivable but ugly: the scan
-- would reference three columns that do not exist and fail on every member.
--
-- One line at a time in the D1 console. "duplicate column" means that line is
-- already done — move to the next.

ALTER TABLE members ADD COLUMN reported_points INTEGER;
ALTER TABLE members ADD COLUMN reported_raw_points INTEGER;
ALTER TABLE members ADD COLUMN reported_completion REAL;
