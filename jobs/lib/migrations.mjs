/**
 * The migrate button, made to work.
 *
 * THE OLD BUTTON looped every file in migrations/ and ran it, on the theory that
 * each one was safe to re-run. Most were not: `ALTER TABLE ... ADD COLUMN` is
 * not idempotent in SQLite, so the loop died on the first migration that had
 * already been applied -- which, by migration 012, was all of them. It was
 * quietly abandoned, and every migration since has been a paste into the D1
 * console followed by "if it says duplicate column name, delete that line and
 * run the rest".
 *
 * THIS KEEPS A LEDGER. `schema_migrations` records every file that has been
 * applied, and the button only runs what is not in it.
 *
 * FIRST RUN BACKFILLS THE LEDGER. On 11 September 2026 every migration through
 * 030 was already applied by hand. An empty ledger on a database that already
 * has 030's `wishlist` table therefore means "001 to 030 are done", and they
 * are recorded without being run. A database WITHOUT that table is a fresh one
 * and gets everything. Probing for the table rather than trusting a date is
 * what makes a from-scratch database safe too.
 *
 * AND IT FORGIVES THE DANCE. Each file runs one statement at a time, and a
 * statement that fails because its column or table is already there is
 * skipped, not fatal. So somebody who pasted a migration into the console AND
 * pressed the button gets a green run instead of a red one. Any other error
 * stops the run without recording the file, so it is retried next time.
 */

export const LEDGER_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name       TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`;

/** Everything up to and including this file was applied by hand before the ledger. */
export const BASELINE = '030-wishlist.sql';
/** A table 030 creates. If it exists, the baseline is true of this database. */
export const BASELINE_TABLE = 'wishlist';

/**
 * Statements in a migration file, in order.
 *
 * Comments are stripped BEFORE splitting, because the prose in these files
 * contains semicolons -- "a repeat is a no-op; nothing else changes" would
 * otherwise become two broken statements. Safe because no migration puts a
 * semicolon or `--` inside a string literal, and a test holds every file to it.
 */
export function splitStatements(sql) {
  return String(sql ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The statement tried to create something that is already there. */
export const alreadyThere = (err) =>
  /duplicate column name|already exists/i.test(String(err?.message ?? err ?? ''));

/**
 * @param {{query: Function, run: Function}} db  - jobs/lib/d1.mjs, or a stub
 * @param {Array<{name: string, sql: string}>} files - every migration, any order
 * @returns {Promise<{baselined: string[], applied: string[], skipped: string[]}>}
 */
export async function runMigrations(db, files, { log = console.log, now = Date.now } = {}) {
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name));
  await db.run(LEDGER_SQL);

  const rows = await db.query('SELECT name FROM schema_migrations');
  const done = new Set(rows.map((r) => r.name));
  const out = { baselined: [], applied: [], skipped: [] };

  if (!done.size) {
    const probe = await db.query(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
      [BASELINE_TABLE],
    );
    if (probe.length) {
      for (const f of sorted.filter((f) => f.name <= BASELINE)) {
        await db.run('INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (?, ?)', [
          f.name, now(),
        ]);
        done.add(f.name);
        out.baselined.push(f.name);
      }
      log(`First run: recorded ${out.baselined.length} migrations already applied by hand (through ${BASELINE}).`);
    }
  }

  for (const f of sorted) {
    if (done.has(f.name)) continue;
    log(`── ${f.name}`);
    for (const statement of splitStatements(f.sql)) {
      try {
        await db.run(statement);
      } catch (err) {
        if (alreadyThere(err)) {
          log(`   already there, skipped: ${statement.split('\n')[0].slice(0, 80)}`);
          out.skipped.push(f.name);
          continue;
        }
        log(`   FAILED: ${err?.message ?? err}`);
        log(`   ${f.name} was NOT recorded, so it will be tried again next time.`);
        throw err;
      }
    }
    await db.run('INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (?, ?)', [
      f.name, now(),
    ]);
    out.applied.push(f.name);
  }

  log(
    out.applied.length
      ? `Applied ${out.applied.length}: ${out.applied.join(', ')}`
      : 'Nothing to apply. The database is up to date.',
  );
  return out;
}
