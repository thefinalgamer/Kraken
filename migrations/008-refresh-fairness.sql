-- 008 — stop one slow member starving the refresh queue
--
-- The weekly refresh scans members oldest-first and a successful scan stamps
-- last_update_at, so people rotate to the back of the queue by themselves.
--
-- Unless the scan never finishes. If GitHub kills the job partway through a
-- member — the 350-minute ceiling, a hung PSN call — that member's
-- last_update_at is never written, so on the next run they are STILL the oldest
-- and consume the budget again. Everyone behind them starves indefinitely, and
-- nothing about it looks like an error.
--
-- last_attempt_at is stamped BEFORE the scan starts, so being tried is enough
-- to lose your place in the queue. Fairness no longer depends on succeeding.

ALTER TABLE members ADD COLUMN last_attempt_at INTEGER;
