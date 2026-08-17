-- Ownership verification for /register.
--
-- Before this, /register took whatever PSN ID you typed and linked it. Anyone
-- could claim anyone — and once claimed, the "already taken" check locked it
-- with no way to undo.
--
-- Run once against the live D1 database:
--   npx wrangler d1 execute platinum-intel --remote --file migrations/001-verification.sql
--
-- Existing members are grandfathered in as verified, since they were added by
-- hand while the board was four people who all know each other.

ALTER TABLE members ADD COLUMN verify_code   TEXT;
ALTER TABLE members ADD COLUMN verified_at   INTEGER;
ALTER TABLE members ADD COLUMN verify_method TEXT;   -- 'discord' | 'bio' | 'grandfathered'

CREATE INDEX IF NOT EXISTS idx_members_verify ON members(verify_code);

UPDATE members
   SET verified_at   = registered_at,
       verify_method = 'grandfathered'
 WHERE verified_at IS NULL
   AND psn_account_id NOT LIKE 'pending:%';
