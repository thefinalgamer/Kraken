/**
 * Cloudflare D1 access over the REST API.
 *
 * The Worker talks to D1 through a native binding, but the scan job runs on a
 * GitHub Actions runner, so it goes over HTTP instead. Same database, so the
 * two halves never disagree about state.
 */

const API = 'https://api.cloudflare.com/client/v4';

export class D1 {
  constructor({ accountId, databaseId, apiToken }) {
    if (!accountId || !databaseId || !apiToken) {
      throw new Error('D1 needs CF_ACCOUNT_ID, CF_D1_DATABASE_ID and CF_API_TOKEN.');
    }
    this.url = `${API}/accounts/${accountId}/d1/database/${databaseId}/query`;
    this.apiToken = apiToken;
  }

  async query(sql, params = []) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql, params }),
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.success === false) {
      const detail = body.errors?.map((e) => e.message).join('; ') || res.statusText;
      throw new Error(`D1 query failed (${res.status}): ${detail}\nSQL: ${sql.slice(0, 200)}`);
    }
    return body.result?.[0]?.results ?? [];
  }

  async one(sql, params = []) {
    const rows = await this.query(sql, params);
    return rows[0] ?? null;
  }

  async run(sql, params = []) {
    await this.query(sql, params);
  }

  /**
   * Batch inserts. D1 caps statement size, so chunk generously but not wildly —
   * a 40-trophy game is one chunk, a 3,000-row backfill is several.
   */
  async batchInsert(table, columns, rows, { chunk = 60, orReplace = true } = {}) {
    if (!rows.length) return;
    const verb = orReplace ? 'INSERT OR REPLACE' : 'INSERT OR IGNORE';
    for (let i = 0; i < rows.length; i += chunk) {
      const slice = rows.slice(i, i + chunk);
      const placeholders = slice
        .map(() => `(${columns.map(() => '?').join(',')})`)
        .join(',');
      const sql = `${verb} INTO ${table} (${columns.join(',')}) VALUES ${placeholders}`;
      await this.run(sql, slice.flat());
    }
  }

  // ------------------------------------------------------------- bot state --

  async getState(key, fallback = null) {
    const row = await this.one('SELECT value FROM kv WHERE key = ?', [key]);
    if (!row) return fallback;
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  }

  async setState(key, value) {
    await this.run(
      'INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
      [key, JSON.stringify(value), Date.now()],
    );
  }
}
