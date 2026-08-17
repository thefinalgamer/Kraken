/**
 * "Link with Discord" — the one-click verification route.
 *
 * Discord has an official PlayStation Network connection (User Settings →
 * Connections → PlayStation Network) where the member signs in with their real
 * Sony credentials in a browser window. So Discord already knows, for certain,
 * which PSN account belongs to which Discord user. The `connections` OAuth
 * scope hands us that list, and we match on the PlayStation entry.
 *
 * That is Sony confirming ownership rather than a string in a bio, and it costs
 * zero PSN API calls. Profile visibility doesn't matter — the scope returns the
 * connection whether or not they've chosen to display it.
 *
 * Why the bio route still exists alongside it
 * -------------------------------------------
 * "Click this link and authorise this app" is the shape of the most common
 * Discord scam, and the consent screen doesn't say "see your PlayStation
 * account" — it says see ALL your linked accounts, Steam and Spotify included.
 * A cautious member will read that properly and hesitate, and they're right to.
 * The bio code grants nothing and can't be abused even in principle. Offering
 * both means nobody has to choose between joining and being careful.
 *
 * State handling: the member's verify_code doubles as the OAuth state. It is
 * already random, already per-member, already stored, and already single-use —
 * so there's nothing extra to keep or expire.
 */

import * as db from './db.mjs';

const AUTHORIZE = 'https://discord.com/api/oauth2/authorize';
const TOKEN = 'https://discord.com/api/oauth2/token';
const CONNECTIONS = 'https://discord.com/api/v10/users/@me/connections';

/** Where Discord sends them back. Must match the Redirect URI in the dev portal. */
export const redirectUri = (env) => `${env.WORKER_BASE_URL}/auth/callback`;

/** The link that goes behind the button in the /register reply. */
export function authorizeUrl(env, verifyCode) {
  const params = new URLSearchParams({
    client_id: env.DISCORD_APPLICATION_ID,
    redirect_uri: redirectUri(env),
    response_type: 'code',
    scope: 'identify connections',
    state: verifyCode,
    prompt: 'consent',
  });
  return `${AUTHORIZE}?${params}`;
}

/**
 * Handles GET /auth/callback.
 * Returns a Response — this is a browser, not Discord, so it gets HTML.
 */
export async function handleCallback(request, env, ctx, dispatchScan) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (url.searchParams.get('error')) {
    return page('Cancelled', 'No harm done — you can close this tab and use the bio code instead.');
  }
  if (!code || !state) return page('Something went wrong', 'That link was missing part of itself. Run `/register` again.');

  const member = await db.memberByVerifyCode(env, state);
  if (!member) {
    return page(
      'That link has expired',
      'Either it has already been used or the registration was cleared. Run `/register` in Discord to start again.',
    );
  }
  if (member.verified_at) {
    return page('Already verified', `**${member.psn_online_id}** is linked and on the board. You can close this tab.`);
  }

  // --- exchange the code for a token -------------------------------------
  let token;
  try {
    const res = await fetch(TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.DISCORD_APPLICATION_ID,
        client_secret: env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri(env),
      }),
    });
    if (!res.ok) throw new Error(`token exchange ${res.status}`);
    token = (await res.json()).access_token;
  } catch (err) {
    console.error('OAuth token exchange failed', err);
    return page('Discord would not talk to us', 'Try again in a minute, or use the bio code instead.');
  }

  // --- read their connected accounts --------------------------------------
  let connections;
  try {
    const res = await fetch(CONNECTIONS, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`connections ${res.status}`);
    connections = await res.json();
  } catch (err) {
    console.error('Fetching connections failed', err);
    return page('Could not read your connections', 'Try again, or use the bio code instead.');
  }

  // Discord's type string for PSN has been both 'playstation' and
  // 'playstation-net' over the years. Accept either rather than break quietly
  // the day they rename it.
  const psn = connections.find(
    (c) => typeof c?.type === 'string' && c.type.toLowerCase().startsWith('playstation'),
  );

  if (!psn) {
    return page(
      'No PlayStation account linked',
      'You have not connected PSN to Discord yet — it is under **User Settings → Connections → ' +
        'PlayStation Network**. Do that and click the link again, or use the bio code instead.',
    );
  }

  const linked = String(psn.name ?? '').trim();
  if (linked.toLowerCase() !== String(member.psn_online_id).trim().toLowerCase()) {
    return page(
      'That is a different account',
      `You registered as **${member.psn_online_id}**, but the PlayStation account linked to your ` +
        `Discord is **${linked}**. Run \`/register\` again with the right one.`,
    );
  }

  await db.markVerified(env, member.discord_id, 'discord');
  ctx.waitUntil(dispatchScan(env, member.discord_id, null, { first: true }));

  return page(
    'Verified',
    `**${member.psn_online_id}** is yours and you're on the board. Your first scan is running now — ` +
      'it takes a while, and Kraken will post in Discord when it lands. You can close this tab.',
  );
}

/** Handles GET /auth/psn?code=KRAKEN-XXXXXX — bounces them to Discord. */
export async function handleStart(request, env) {
  const url = new URL(request.url);
  const verifyCode = url.searchParams.get('code');
  if (!verifyCode) return page('Missing code', 'Run `/register` in Discord to get your link.');

  const member = await db.memberByVerifyCode(env, verifyCode);
  if (!member) return page('That link has expired', 'Run `/register` in Discord to start again.');
  if (member.verified_at) return page('Already verified', 'Nothing left to do — close this tab.');

  return Response.redirect(authorizeUrl(env, verifyCode), 302);
}

// ---------------------------------------------------------------- html ----

function page(heading, body) {
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(heading)} · Platinum Intel</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:#0f1115; color:#e6e8ec;
         font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; padding:24px; }
  main { max-width:34rem; text-align:center; }
  h1 { font-size:1.5rem; margin:0 0 .75rem; letter-spacing:-.01em; }
  p { margin:0; color:#a8aeba; }
  strong { color:#e6e8ec; font-weight:600; }
  .mark { width:44px; height:44px; margin:0 auto 1.25rem; border-radius:12px;
          background:linear-gradient(145deg,#4a9eff,#2563eb); }
</style>
</head><body><main>
  <div class="mark"></div>
  <h1>${escape(heading)}</h1>
  <p>${body.replace(/\*\*(.+?)\*\*/g, (_, t) => `<strong>${escape(t)}</strong>`)}</p>
</main></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

const escape = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
