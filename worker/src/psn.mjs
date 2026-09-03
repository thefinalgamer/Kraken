/**
 * The smallest possible PSN client, for the Worker.
 *
 * `jobs/lib/psn.mjs` is the real one and it stays the real one: it paces
 * itself, pages through libraries, backs off, and does the whole scan. It also
 * depends on the `psn-api` package and on `process.env`, neither of which
 * exists inside a Worker.
 *
 * This is two calls and a token, written against the same endpoints by hand:
 *
 *   what has this member touched recently, and how many trophies do they have
 *   in it now
 *
 *   what are the trophies in that one game, and when did they earn each one
 *
 * That is everything the live pop needs and nothing else. If it ever grows a
 * third call, that is the moment to ask whether this belongs in the Worker at
 * all.
 *
 * WHY THE WORKER AND NOT ACTIONS. A GitHub cron fires every five minutes at
 * best and takes half a minute to boot a runner, which is a lifetime when the
 * point is a card on screen while chat is still reacting. The cost of that
 * choice is this file and the credential it needs, which is why everything
 * around it is built to fail closed.
 */

const AUTH = 'https://ca.account.sony.com/api/authz/v3/oauth';
const API = 'https://m.np.playstation.com/api/trophy/v1';

/**
 * Sony has no public trophy API and no developer programme for one. Every
 * trophy site and bot, this one included, talks to the endpoints the
 * PlayStation app uses, with the app's own public client id. These two values
 * are not secrets and are not ours; the NPSSO cookie is the secret.
 */
const CLIENT_ID = '09515159-7237-4370-9b40-3806e67c0891';
const CLIENT_SECRET = 'ucPjka5tntB2KqsP';
const REDIRECT = 'com.scee.psxandroid.scecompcall://redirect';
const SCOPE = 'psn:mobile.v2.core psn:clientapp';

const basic = () => btoa(`${CLIENT_ID}:${CLIENT_SECRET}`);

/**
 * PS5 titles live on a newer service and must send NO npServiceName. Everything
 * older sends "trophy". The value on the title object cannot be used directly:
 * PS5 reports "trophy2", which these endpoints reject.
 */
const serviceFor = (platform = '') => (String(platform).includes('PS5') ? null : 'trophy');

/** NPSSO cookie to an authorization code. The code is single use. */
async function codeFromNpsso(npsso) {
  const url = new URL(`${AUTH}/authorize`);
  url.search = new URLSearchParams({
    access_type: 'offline',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: SCOPE,
  }).toString();

  /**
   * MANUAL REDIRECTS, and this is the whole trick. The code comes back in the
   * Location header of a 302 that points at a custom scheme the app owns.
   * Following it, which fetch does by default, throws the answer away.
   */
  const res = await fetch(url, {
    redirect: 'manual',
    headers: { Cookie: `npsso=${npsso}` },
  });

  const location = res.headers.get('location') ?? '';
  const code = /[?&]code=([^&]+)/.exec(location)?.[1];
  if (!code) throw new Error(`psn authorize gave no code (${res.status})`);
  return code;
}

async function tokenCall(body) {
  const res = await fetch(`${AUTH}/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic()}`,
    },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) throw new Error(`psn token ${res.status}`);
  return res.json();
}

const exchange = async (code) =>
  tokenCall({
    code,
    redirect_uri: REDIRECT,
    grant_type: 'authorization_code',
    token_format: 'jwt',
  });

const refresh = async (refreshToken) =>
  tokenCall({
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    scope: SCOPE,
    token_format: 'jwt',
  });

/**
 * An access token, from the cheapest source that still works.
 *
 * Three tiers, in order of cost: the cached access token, a refresh, and only
 * then the NPSSO. The NPSSO is the one a human has to replace by hand every
 * couple of months, so it is touched as rarely as possible.
 *
 * Tokens live in `worker_state`, the same scratchpad the Twitch token uses.
 */
export async function accessToken(env) {
  if (!env.PSN_NPSSO) throw new Error('no npsso configured');

  const now = Date.now();
  const read = async (key) =>
    env.DB.prepare('SELECT value, expires_at FROM worker_state WHERE key = ?')
      .bind(key)
      .first()
      .catch(() => null);

  const write = (key, value, expiresAt) =>
    env.DB.prepare(
      `INSERT INTO worker_state (key, value, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
    )
      .bind(key, value, expiresAt)
      .run();

  const cached = await read('psn_access');
  if (cached?.value && Number(cached.expires_at) > now + 30000) return cached.value;

  const store = async (t) => {
    // A minute of slack, so a token cannot expire between being read and used.
    await write('psn_access', t.access_token, now + (Number(t.expires_in) || 3600) * 1000 - 60000);
    if (t.refresh_token) {
      await write(
        'psn_refresh',
        t.refresh_token,
        now + (Number(t.refresh_token_expires_in) || 60 * 86400) * 1000,
      );
    }
    return t.access_token;
  };

  const stored = await read('psn_refresh');
  if (stored?.value && Number(stored.expires_at) > now) {
    try {
      return await store(await refresh(stored.value));
    } catch {
      // Fall through to the NPSSO. A refresh token that Sony has decided it
      // does not like any more is not worth a second attempt.
    }
  }

  return store(await exchange(await codeFromNpsso(env.PSN_NPSSO)));
}

async function get(env, path, token) {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 429) {
    const err = new Error('psn rate limited');
    err.rateLimited = true;
    throw err;
  }
  if (!res.ok) throw new Error(`psn ${path.split('?')[0]} ${res.status}`);
  return res.json();
}

/**
 * The handful of games they have touched most recently.
 *
 * This is the cheap call: one request, and the earned counts on it are what
 * says whether anything has happened at all. Ten titles rather than the
 * hundreds the scan pages through, because somebody streaming has not quietly
 * played eleven other games in the last ten seconds.
 */
export async function recentTitles(env, accountId, token, limit = 10) {
  const json = await get(env, `/users/${accountId}/trophyTitles?limit=${limit}&offset=0`, token);
  return json?.trophyTitles ?? [];
}

/** Every trophy in one title, with the date this member earned each one. */
export async function earnedForTitle(env, accountId, npCommId, platform, token) {
  const service = serviceFor(platform);
  const q = service ? `?npServiceName=${service}` : '';
  const json = await get(
    env,
    `/users/${accountId}/npCommunicationIds/${npCommId}/trophyGroups/all/trophies${q}`,
    token,
  );
  return json?.trophies ?? [];
}
