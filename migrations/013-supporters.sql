-- The supporter star.
--
-- COSMETIC, AND THAT IS A HARD RULE. Nothing in this table may ever reach the
-- scoring. Not points, not rank, not tier, not the order of a single list. The
-- entire worth of this board is that it is a record of what people earned, and
-- the moment money can move a row it stops being that. A star beside a name is
-- a thank-you; it is not a purchase.
--
-- NO PAYMENT DATA EVER TOUCHES KRAKEN. Ko-fi handles the money. All that lands
-- here is a count of months, set by a mod. The database holds no card, no
-- amount, no email, no transaction — so there is nothing here worth stealing
-- and nothing to leak.
--
-- MONTHS ONLY EVER GO UP. The star is permanent by construction: it says "you
-- helped", not "you are currently subscribed". Nobody has one taken away, and
-- the site never has to track whether a payment is still live.
--
-- Run these ONE AT A TIME in the D1 console. ALTER TABLE ADD COLUMN cannot be
-- batched, and a migration that ships after the code that needs it takes the
-- whole site down — SQLite rejects the entire query for one unknown column.
-- Migration first, push second. Always.

ALTER TABLE members ADD COLUMN supporter_months INTEGER NOT NULL DEFAULT 0;

-- When they first chipped in. Only used to say "since March 2026" on hover;
-- the tier comes from the month count, never from this date, so a gap in
-- support cannot silently promote anybody.
ALTER TABLE members ADD COLUMN supporter_since INTEGER;
