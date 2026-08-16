/**
 * Rate-limited PlayStation Network client.
 *
 * Sony has no public trophy API. Everyone — PSNProfiles, PSN100, every trophy
 * bot — reads the same private endpoints the PlayStation website uses, via an
 * NPSSO cookie taken from a logged-in browser session. The refresh token that
 * comes from it lasts roughly two months, after which a human must paste in a
 * fresh NPSSO. That is the one chore in this system that cannot be automated.
 *
 * Pacing: the community-accepted safe ceiling is 300 requests / 15 minutes.
 * The original bot ran at roughly 420/15min (280 games in 10 minutes), which
 * worked but sat above that line. We pace at 280/15min, so a 280-game first
 * scan lands around 14 minutes instead of 10. Repeat updates are unaffected —
 * they only touch games whose trophy count actually moved.
 */

import {
  exchangeNpssoForAccessCode,
  exchangeAccessCodeForAuthTokens,
  exchangeRefreshTokenForAuthTokens,
  getUserTitles,
  getTitleTrophies,
  getUserTrophiesEarnedForTitle,
  getUserTrophyProfileSummary,
  getProfileFromUserName,
  makeUniversalSearch,
} from 'psn-api';

const WINDOW_MS = 15 * 60 * 1000;
const MAX_IN_WINDOW = 280;

export class RateLimiter {
  constructor(max = MAX_IN_WINDOW, windowMs = WINDOW_MS) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = [];
  }

  async take() {
    for (;;) {
      const now = Date.now();
      this.hits = this.hits.filter((t) => now - t < this.windowMs);
      if (this.hits.length < this.max) {
        this.hits.push(now);
        return;
      }
      const waitMs = this.windowMs - (now - this.hits[0]) + 50;
      await sleep(waitMs);
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * PSN splits its trophy endpoints across two "services". PS5 titles live on the
 * newer one and must send NO npServiceName; everything older (PS3, PS4, Vita)
 * must send "trophy". Sending the raw value from the title object doesn't work —
 * PS5 titles report "trophy2", which these endpoints reject.
 */
const serviceNameFor = (platform = '') =>
  String(platform).includes('PS5') ? undefined : 'trophy';

export class PsnClient {
  /**
   * @param {object} opts
   * @param {string} [opts.npsso]        - fresh NPSSO cookie (first run / re-auth)
   * @param {string} [opts.refreshToken] - stored refresh token (normal path)
   * @param {(state:object)=>Promise<void>} [opts.onTokens] - persist new tokens
   */
  constructor(opts = {}) {
    this.npsso = opts.npsso;
    this.refreshToken = opts.refreshToken;
    this.onTokens = opts.onTokens || (async () => {});
    this.auth = null;
    this.limiter = new RateLimiter();
    this.requestCount = 0;
  }

  async authenticate() {
    if (this.refreshToken) {
      try {
        this.auth = await exchangeRefreshTokenForAuthTokens(this.refreshToken);
      } catch (err) {
        if (!this.npsso) {
          throw new PsnAuthError(
            'PSN refresh token is expired or invalid and no NPSSO was supplied. ' +
              'A human needs to paste a fresh NPSSO — see SETUP.md step 5.',
            { cause: err },
          );
        }
      }
    }
    if (!this.auth) {
      if (!this.npsso) throw new PsnAuthError('No NPSSO and no refresh token available.');
      const code = await exchangeNpssoForAccessCode(this.npsso);
      this.auth = await exchangeAccessCodeForAuthTokens(code);
    }

    const expiresAt = Date.now() + this.auth.refreshTokenExpiresIn * 1000;
    await this.onTokens({
      refreshToken: this.auth.refreshToken,
      refreshTokenExpiresAt: expiresAt,
    });
    this.refreshTokenExpiresAt = expiresAt;
    return this.auth;
  }

  /** Days until a human has to intervene. The bot warns in Discord at <= 3. */
  daysUntilReauth() {
    if (!this.refreshTokenExpiresAt) return null;
    return Math.floor((this.refreshTokenExpiresAt - Date.now()) / 86_400_000);
  }

  /** Every PSN call funnels through here: paced, retried, and counted. */
  async #call(fn, ...args) {
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; ; attempt++) {
      await this.limiter.take();
      this.requestCount++;
      try {
        return await fn(this.auth, ...args);
      } catch (err) {
        const status = err?.response?.status ?? err?.status;

        // Private profile / not permitted — a real answer, not a failure to retry.
        if (status === 403 || status === 404) throw new PsnPrivateError(status);

        if (status === 401 && attempt === 1) {
          await this.authenticate();
          continue;
        }
        if (attempt >= MAX_ATTEMPTS) throw err;

        // 429 and 5xx: back off hard. Better a slow refresh than a throttled account.
        const backoff = status === 429 ? 60_000 * attempt : 2_000 * 2 ** attempt;
        await sleep(backoff);
      }
    }
  }

  // ---------------------------------------------------------------- lookups --

  /** Resolve a PSN online ID to the stable numeric account id. */
  async findAccount(onlineId) {
    const search = await this.#call(makeUniversalSearch, onlineId, 'SocialAllAccounts');
    const hit = search?.domainResponses?.[0]?.results?.find(
      (r) => r.socialMetadata?.onlineId?.toLowerCase() === onlineId.toLowerCase(),
    );
    if (!hit) return null;
    const meta = hit.socialMetadata;
    return {
      accountId: meta.accountId,
      onlineId: meta.onlineId,
      avatarUrl: meta.avatarUrl,
    };
  }

  async profile(onlineId) {
    return this.#call(getProfileFromUserName, onlineId);
  }

  /** Overall trophy counts and level. One call — the cheap per-member signal. */
  async summary(accountId) {
    return this.#call(getUserTrophyProfileSummary, accountId);
  }

  /**
   * A member's played games with per-game progress. Paginated at 800.
   * This is the change-detection layer: if earnedTrophies here hasn't moved
   * since last time, that game needs no deep scan at all.
   */
  async titles(accountId) {
    const all = [];
    let offset = 0;
    for (;;) {
      const page = await this.#call(getUserTitles, accountId, { limit: 800, offset });
      const batch = page?.trophyTitles ?? [];
      all.push(...batch);
      const total = page?.totalItemCount ?? all.length;
      if (!batch.length || all.length >= total) break;
      offset += batch.length;
    }
    return all;
  }

  /**
   * A game's trophy definitions plus WORLDWIDE earn rates.
   * Identical for every member, so this is cached globally and fetched once
   * per game rather than once per member per game.
   */
  async titleTrophies(npCommunicationId, platform) {
    const res = await this.#call(
      getTitleTrophies,
      npCommunicationId,
      'all',
      { npServiceName: serviceNameFor(platform) },
    );
    return res?.trophies ?? [];
  }

  /** Which trophies in a game this specific member has earned. */
  async earnedForTitle(accountId, npCommunicationId, platform) {
    const res = await this.#call(
      getUserTrophiesEarnedForTitle,
      accountId,
      npCommunicationId,
      'all',
      { npServiceName: serviceNameFor(platform) },
    );
    return res?.trophies ?? [];
  }
}

export class PsnAuthError extends Error {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'PsnAuthError';
  }
}

export class PsnPrivateError extends Error {
  constructor(status) {
    super(
      'This PSN profile is not readable. The member needs to set ' +
        'Settings → Users and Accounts → Privacy → Trophies to "Anyone".',
    );
    this.name = 'PsnPrivateError';
    this.status = status;
  }
}
