/**
 * Actions -> Admin -> Run workflow -> migrate.
 *
 * Applies every migration in migrations/ that the database has not had yet, and
 * records each one so it is never run twice. See jobs/lib/migrations.mjs for
 * the ledger and why the first run is special.
 *
 * The logic lives in Node rather than in admin.yml ON PURPOSE: workflow files
 * have to be placed by hand, so the less that lives in one, the less ever has
 * to be placed by hand again.
 */

import { readdir, readFile } from 'node:fs/promises';
import { D1 } from './lib/d1.mjs';
import { runMigrations } from './lib/migrations.mjs';

const dir = new URL('../migrations/', import.meta.url);
const names = (await readdir(dir)).filter((f) => f.endsWith('.sql'));
const files = await Promise.all(
  names.map(async (name) => ({ name, sql: await readFile(new URL(name, dir), 'utf8') })),
);

const db = new D1({
  accountId: process.env.CF_ACCOUNT_ID,
  databaseId: process.env.CF_D1_DATABASE_ID,
  apiToken: process.env.CF_API_TOKEN,
});

try {
  await runMigrations(db, files);
} catch {
  process.exitCode = 1;
}
