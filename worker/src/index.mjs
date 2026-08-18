/**
 * Discord interactions endpoint.
 *
 * Discord supports an HTTP interactions URL, which means slash commands do not
 * need a process running 24/7 — Discord posts here, we reply, nothing runs in
 * between. That is what makes this whole thing maintenance-free apart from the
 * PSN token.
 *
 * Anything that finishes in milliseconds is answered here from D1. /update is
 * the exception: it dispatches to GitHub Actions and gets edited in later.
 */

import { verifyKey } from './verify.mjs';
import * as db from './db.mjs';
import * as oauth from './oauth.mjs';
import {
  message, container, text, section, thumbnail, row, button, linkButton, separator,
  memberCard, boardBlocks, configureEmoji, COLOR, STYLE, n, pct, ordinal,
  trophyLine, FALLBACK_AVATAR,
} from '../../shared/ui.mjs';
import { trophyPoints, rarityBand, RARITY_BANDS } from '../../shared/scoring.mjs';

const TYPE = { PING: 1, COMMAND: 2, COMPONENT: 3, AUTOCOMPLETE: 4 };
const REPLY = { PONG: 1, MESSAGE: 4, DEFER: 5, UPDATE_MESSAGE: 7, AUTOCOMPLETE: 8 };

export default {
  async fetch(request, env, ctx) {
    // Worker config arrives via the env binding, not process.env.
    configureEmoji(env);

    // Browser traffic — the "link with Discord" verification round trip. These
    // are real people in a real browser, not Discord posting an interaction, so
    // they get HTML back and none of the signature checking below applies.
    if (request.method === 'GET') {
      const path = new URL(request.url).pathname;
      if (path === '/auth/psn') return oauth.handleStart(request, env);
      if (path === '/auth/callback') return oauth.handleCallback(request, env, ctx, dispatchScan);
      return new Response('Kraken is alive.', { status: 200 });
    }

    if (request.method !== 'POST') return new Response('Kraken is alive.', { status: 200 });

    const signature = request.headers.get('x-signature-ed25519');
    const timestamp = request.headers.get('x-signature-timestamp');
    const body = await request.text();

    if (!signature || !timestamp || !(await verifyKey(body, signature, timestamp, env.DISCORD_PUBLIC_KEY))) {
      return new Response('Bad request signature', { status: 401 });
    }

    const interaction = JSON.parse(body);
    if (interaction.type === TYPE.PING) return json({ type: REPLY.PONG });

    try {
      const reply =
        interaction.type === TYPE.COMMAND
          ? await handleCommand(interaction, env, ctx)
          : interaction.type === TYPE.COMPONENT
            ? await handleComponent(interaction, env, ctx)
            : interaction.type === TYPE.AUTOCOMPLETE
              ? await handleAutocomplete(interaction, env)
              : null;
      return json(reply ?? errorReply('I did not understand that interaction.'));
    } catch (err) {
      console.error(err);
      return json(errorReply(err.message || 'Something went wrong.'));
    }
  },
};

const json = (data) => new Response(JSON.stringify(data), {
  headers: { 'Content-Type': 'application/json' },
});

const errorReply = (msg) => ({
  type: REPLY.MESSAGE,
  data: message([container([text(`⚠️ ${msg}`)], COLOR.red)], { ephemeral: true }),
});

const reply = (components, opts) => ({ type: REPLY.MESSAGE, data: message(components, opts) });
const update = (components) => ({ type: REPLY.UPDATE_MESSAGE, data: message(components) });

// ------------------------------------------------------------- commands ----

async function handleCommand(interaction, env, ctx) {
  const name = interaction.data.name;
  const userId = interaction.member?.user?.id ?? interaction.user?.id;
  const opt = (key) => interaction.data.options?.find((o) => o.name === key)?.value;

  switch (name) {
    case 'register':   return register(interaction, env, ctx, userId, opt('psn-id'));
    case 'verify':     return verify(interaction, env, ctx, userId);
    case 'unlink':     return unlink(interaction, env, opt('member'));
    case 'update':     return runUpdate(interaction, env, ctx, userId);
    case 'rank':       return rank(env, opt('member') ?? userId);
    case 'leaderboard':return leaderboard(env, Number(opt('page') ?? 1), userId);
    case 'game':       return game(env, opt('title'), userId);
    case 'backlog':    return backlog(env, userId, opt('sort') ?? 'value');
    default:           return errorReply(`Unknown command \`/${name}\`.`);
  }
}

/**
 * Registration, gated by role during the soft launch so the board can be built
 * up a few people at a time rather than 300 first scans landing at once.
 */
async function register(interaction, env, ctx, userId, psnId) {
  if (env.HUNTER_ROLE_ID) {
    const roles = interaction.member?.roles ?? [];
    if (!roles.includes(env.HUNTER_ROLE_ID)) {
      return errorReply(
        'The leaderboard is still in testing and only open to invited members for now. ' +
          'Ask a mod if you want in early.',
      );
    }
  }

  const existing = await db.memberByDiscordId(env, userId);

  if (existing?.verified_at) {
    return errorReply(
      `You're already registered as **${existing.psn_online_id}**. ` +
        'Ask a mod if you need it changed.',
    );
  }

  // Half-finished registration. Anything can interrupt one — a failed OAuth
  // hop, a mistyped bio, closing the tab, the ephemeral reply scrolling away
  // and taking the code with it. Refusing here would strand them: /register
  // says "already registered", they have no code left, and only a mod can free
  // them. So re-issue instead. A fresh code invalidates the old one, which is
  // what you'd want anyway.
  if (existing) {
    const reissued = makeVerifyCode();
    await db.reissueVerifyCode(env, userId, existing.psn_online_id, psnId, reissued);
    return verificationPrompt(env, psnId || existing.psn_online_id, reissued, true);
  }

  // Only a VERIFIED claim blocks the name. Unverified rows lapse after an hour,
  // so nobody can squat on "Pelzio" by typing it first and never proving it.
  const taken = await db.claimBlockedBy(env, psnId);
  if (taken) {
    return errorReply(
      taken.verified_at
        ? `**${psnId}** is already claimed and verified by someone here. If that's wrong, ask a mod.`
        : `Somebody is part-way through claiming **${psnId}**. Try again in an hour.`,
    );
  }

  // No scan yet. Nothing touches PSN and nothing reaches the board until they
  // have proved the account is theirs — that is the entire point of this step.
  const verifyCode = makeVerifyCode();
  await db.createProvisionalMember(env, { discordId: userId, onlineId: psnId, verifyCode });

  return verificationPrompt(env, psnId, verifyCode, false);
}

/** The two-routes message. Shared, because a retry has to say the same thing. */
function verificationPrompt(env, psnId, verifyCode, isRetry) {
  return reply(
    [
      container(
        [
          text(
            (isRetry
              ? `## Let's try that again\n\nHere's a fresh code for **${psnId}** — the old one no ` +
                `longer works.\n\n`
              : `## Almost there\n\nBefore **${psnId}** goes on the board, prove it's yours. ` +
                `Two ways — pick whichever you're comfortable with.\n\n`) +
              `### The quick way\n` +
              `Hit the button below. It uses the PlayStation account you've already linked to ` +
              `Discord under **User Settings → Connections**, so there's nothing to type. ` +
              `Kraken reads which accounts you've connected, looks only at the PlayStation one, ` +
              `and stores nothing else. It cannot read your messages or post as you.\n\n` +
              `### The no-permissions way\n` +
              `Put this code anywhere in your PSN **About Me**, then run \`/verify\`:\n` +
              `\`\`\`\n${verifyCode}\n\`\`\`\n` +
              `Console: **Profile → Edit Profile → About Me**. You can delete it straight after.\n\n` +
              `-# Also check your trophies are public — Settings → Users and Accounts → Privacy → ` +
              `Trophies → **Anyone** — or the scan will find nothing.\n` +
              `-# Stuck? Run \`/register\` again for a fresh code.`,
          ),
          row(linkButton('Link with Discord', `${env.WORKER_BASE_URL}/auth/psn?code=${verifyCode}`)),
        ],
        COLOR.blurple,
      ),
    ],
    { ephemeral: true },
  );
}

/**
 * Codes people have to retype off a phone screen, so no 0/O or 1/I/l.
 * Six characters from a 30-letter alphabet is comfortably unguessable for
 * something that expires the moment it's used.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function makeVerifyCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return `KRAKEN-${out}`;
}

/**
 * The bio route. The Worker has no PSN credentials, so it cannot read an About
 * Me itself — the scan job does the check as its first act and refuses to go
 * any further if the code isn't there.
 */
async function verify(interaction, env, ctx, userId) {
  const member = await db.memberByDiscordId(env, userId);
  if (!member) return errorReply('You have not registered yet — run `/register` with your PSN ID first.');
  if (member.verified_at) {
    return errorReply(`**${member.psn_online_id}** is already verified. Use \`/update\` to rescan.`);
  }

  const running = await db.hasRunningUpdate(env, member.psn_account_id);
  if (running) return errorReply('Already checking. Give it a minute.');

  ctx.waitUntil(dispatchScan(env, userId, interaction.token, { first: true, verify: true }));

  return reply([
    container(
      [
        text(
          `## Checking **${member.psn_online_id}**\n\n` +
            `Looking for \`${member.verify_code}\` in your PSN About Me. If it's there, your first ` +
            `scan starts straight away.\n\n` +
            `First scans are the slow ones — **15 to 30 minutes** — because nothing about your ` +
            `library is cached yet. Every update after this takes two or three.`,
        ),
      ],
      COLOR.green,
    ),
  ]);
}

/**
 * Mod tooling. Impersonation in a community this size gets spotted in minutes
 * and is socially expensive — the real problem was that it could not be UNDONE.
 * This turns a permanent mess into a thirty-second annoyance.
 */
async function unlink(interaction, env, targetId) {
  const perms = BigInt(interaction.member?.permissions ?? '0');
  const MANAGE_GUILD = 1n << 5n;
  const isMod = (perms & MANAGE_GUILD) === MANAGE_GUILD;
  if (!isMod) return errorReply('That one is for mods only.');

  if (!targetId) return errorReply('Tell me who to unlink.');

  const removed = await db.unlinkMember(env, targetId);
  if (!removed) return errorReply('That person is not registered.');

  return reply(
    [
      container(
        [
          text(
            `Unlinked <@${targetId}> from **${removed.psn_online_id}**.\n\n` +
              `-# The name is free again and they can re-register. Their scan history stays put.`,
          ),
        ],
        COLOR.orange,
      ),
    ],
    { ephemeral: true },
  );
}

async function runUpdate(interaction, env, ctx, userId) {
  const member = await db.memberByDiscordId(env, userId);
  if (!member) return errorReply('You are not registered yet — run `/register` with your PSN ID.');

  const running = await db.hasRunningUpdate(env, member.psn_account_id);
  if (running) return errorReply('You already have an update running. Give it a minute.');

  ctx.waitUntil(dispatchScan(env, userId, interaction.token));

  // Scans run one at a time server-wide. If somebody's ahead, say so — an
  // unexplained ten-minute silence is indistinguishable from a broken bot.
  const active = (await db.activeScans(env)).filter(
    (s) => s.psn_online_id !== member.psn_online_id,
  );

  let body = `## ${member.psn_online_id} update queued\n\nScanning PSN now — this message will fill itself in.`;

  if (active.length) {
    const ahead = active[0];
    const mins = Math.max(1, Math.round((Date.now() - ahead.started_at) / 60000));

    // The database only knows about scans that have STARTED. Anyone waiting
    // behind them is queued at GitHub, invisible from here — so ask GitHub.
    // Without this, the twelfth person in line is told "one person is ahead of
    // you", waits an hour, and reasonably concludes the bot is broken.
    const waiting = await queueDepth(env);
    const position = Math.max(active.length, waiting) + 1;
    const eta = position * 3; // repeat scans are 2–4 minutes; first scans blow this out

    body =
      `## ${member.psn_online_id} update queued\n\n` +
      `**${ahead.psn_online_id}** is scanning right now — ${mins} minute${mins === 1 ? '' : 's'} in.\n\n` +
      (position > 1
        ? `You're **${ordinal(position)}** in the queue, so roughly **${eta} minutes** — longer if ` +
          `anyone ahead of you is on their first scan.\n\n`
        : `You're next.\n\n`) +
      `This message will fill itself in when it's your turn. Nothing's broken — scans run one ` +
      `at a time so nobody trips PlayStation's rate limit.`;
  }

  return reply([container([text(body)], active.length ? COLOR.orange : COLOR.grey)]);
}

/**
 * How many scans are queued or running, straight from GitHub Actions.
 *
 * GitHub is the actual queue — `concurrency: queue: max` holds pending runs
 * there, and D1 never sees them because a row is only written once a scan
 * starts. Returns 0 on any failure: a wrong queue estimate is a far smaller
 * problem than /update falling over because the GitHub API had a moment.
 */
async function queueDepth(env) {
  try {
    // HARD TIMEOUT. Discord gives an interaction three seconds, total. This
    // call is a nicety — it turns "queued" into "you're 4th, about 12 minutes"
    // — and a nicety must never be allowed to blow the deadline for the reply
    // itself. If GitHub is slow, we say nothing rather than saying nothing at
    // all, which is what a missed deadline actually looks like to the member:
    // "Kraken didn't respond in time".
    const res = await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/scan.yml/runs` +
        `?per_page=30&exclude_pull_requests=true`,
      {
        signal: AbortSignal.timeout(800),
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'platinum-intel-bot',
        },
      },
    );
    if (!res.ok) return 0;
    const { workflow_runs = [] } = await res.json();
    return workflow_runs.filter((r) => r.status === 'queued' || r.status === 'in_progress').length;
  } catch {
    return 0;
  }
}

async function rank(env, target) {
  const member = await db.memberByDiscordId(env, target);
  if (!member) return errorReply('That member is not on the board yet.');

  // The person above, you, and the person below. Two either side was five
  // cards, which is a wall rather than an answer — and the two extra were
  // people nobody is racing. Knowing who is four hundred points behind and
  // closing motivates as much as knowing who you are chasing.
  const neighbours = await db.neighbours(env, member.rank ?? 1, 1);
  const total = await db.memberCount(env);
  const cards = neighbours.map((m, i) =>
    memberCard(m, {
      total,
      highlight: m.discord_id === member.discord_id,
      above: neighbours[i - 1] ?? null,
      showTier: true,
    }),
  );
  return reply(
    [
      text(`**${member.psn_online_id}** — ${ordinal(member.rank)} of ${n(total)}`),
      ...cards,
      row(
        button('Full leaderboard', `lb:${Math.max(1, Math.ceil((member.rank ?? 1) / 10))}`),
        button('Refresh my stats', 'do:update', STYLE.PRIMARY),
        button('Share to channel', `share:rank:${target}`, STYLE.SECONDARY),
      ),
    ],
    // Personal stats are answered privately. With a hundred members, every
    // /rank posting publicly turns the main channel into a wall of other
    // people's numbers — so the default is quiet, with a button for when
    // somebody actually wants to show off.
    { ephemeral: true },
  );
}

async function leaderboard(env, page, viewerId) {
  const size = Number(env.LEADERBOARD_PAGE_SIZE ?? 10);
  const total = await db.memberCount(env);
  const pages = Math.max(1, Math.ceil(total / size));
  const safePage = Math.min(Math.max(1, page), pages);
  const offset = (safePage - 1) * size;
  const members = await db.leaderboardPage(env, offset, size);


  return reply([
    text(
      `## Platinum Intel\n-# Ranked by rarity points · page ${safePage} of ${pages} · ${n(total)} hunters`,
    ),
    // Tier blocks, not cards. Discord counts nested components against a limit
    // of 40 and a card is 8 of them, so cards broke the board the moment a
    // fifth member registered — reporting itself as "Kraken didn't respond in
    // time", which points nowhere near the cause. A tier is three components
    // however many people are in it. See boardBlocks() in ui.mjs.
    ...boardBlocks(members, { viewerId, total, startRank: offset + 1 }),
    row(
      button('◀ Prev', `lb:${safePage - 1}`, STYLE.SECONDARY, { disabled: safePage <= 1 }),
      button('Next ▶', `lb:${safePage + 1}`, STYLE.SECONDARY, { disabled: safePage >= pages }),
      button('Jump to me', 'lb:me', STYLE.PRIMARY),
    ),
  ]);
}

async function game(env, query, userId) {
  const found = await db.findGame(env, query);
  if (!found) {
    return errorReply(
      `Nobody here has played anything called **${query}** yet, so I have no rarity data for it. ` +
        'Once one member owns it, it shows up for everyone.',
    );
  }

  const member = await db.memberByDiscordId(env, userId);
  const trophies = await db.gameTrophies(env, found.np_comm_id);
  const mine = member ? await db.memberGame(env, member.psn_account_id, found.np_comm_id) : null;
  const earned = new Set(mine ? JSON.parse(mine.earned_ids || '[]') : []);

  const remaining = trophies.filter((t) => !earned.has(t.trophy_id));
  const worth = remaining.reduce((sum, t) => sum + (t.points || 0), 0);
  const plat = trophies.find((t) => t.type === 'platinum');

  const top = [...remaining]
    .sort((a, b) => (b.points || 0) - (a.points || 0))
    .slice(0, 3)
    .map(
      (t, i) =>
        `**${i + 1}.** ${t.name} · *${t.type}*\n` +
        `-# ${pct(t.earned_rate)} earned · ${RARITY_BANDS[rarityBand(t.earned_rate)]} · **+${n(t.points)} points**`,
    );

  const owners = await db.gameOwners(env, found.np_comm_id);

  return reply([
    container(
      [
        section(
          [
            `## ${found.title}\n-# ${found.platform ?? 'PlayStation'} · ${n(found.trophy_count)} trophies`,
            `**Worth to you:** +${n(worth)} points` +
              (mine ? `\n**Your progress:** ${mine.progress}%` : '\n**Your progress:** not started'),
            plat ? `**Plat rarity:** ${pct(plat.earned_rate)} · ${RARITY_BANDS[rarityBand(plat.earned_rate)]}` : '',
          ].filter(Boolean),
          thumbnail(found.icon_url || FALLBACK_AVATAR, found.title),
        ),
        separator(),
        text(['**Biggest earners left**', ...top].join('\n')),
        separator(),
        text(
          `-# ${n(owners.platted)} of ${n(owners.total)} members here have platted this` +
            (owners.fastest ? ` · fastest was **${owners.fastest}**` : ''),
        ),
        row(button("Who's played it", `owners:${found.np_comm_id}`)),
      ],
      COLOR.blurple,
    ),
  ]);
}

/**
 * What to play next. The old bot told you your backlog was 280 games and left
 * you to it; this ranks them by what finishing them is actually worth.
 */
async function backlog(env, userId, sort) {
  const member = await db.memberByDiscordId(env, userId);
  if (!member) return errorReply('You are not registered yet — run `/register` with your PSN ID.');

  const rows = await db.backlog(env, member.psn_account_id, sort, 5);
  if (!rows.length) {
    return errorReply('Nothing unfinished on record yet. Run `/update` first.');
  }

  const lines = rows.map((g, i) => {
    const band = g.plat_rate != null ? ` · ${RARITY_BANDS[rarityBand(g.plat_rate)]}` : '';
    return (
      `**${i + 1}. ${g.title}** — +${n(g.remaining_points)} points\n` +
      `-# ${n(g.remaining_trophies)} trophies left · ${g.progress}% done${band}`
    );
  });

  // The line that makes it more than a to-do list.
  const projected = member.points + rows.slice(0, 3).reduce((s, g) => s + g.remaining_points, 0);
  const wouldBe = await db.rankForPoints(env, projected);
  const gain = (member.rank ?? 0) - wouldBe;
  const passed = gain > 0 ? await db.membersBetween(env, wouldBe, member.rank) : [];

  return reply([
    container(
      [
        text(
          `## ${member.psn_online_id}'s backlog\n` +
            `-# ${n(member.projects - member.completed)} unfinished · sorted by points per remaining trophy\n\n` +
            lines.join('\n\n'),
        ),
        separator(),
        text(
          gain > 0
            ? `-# Finishing the top 3 would put you at **${ordinal(wouldBe)}** — up ${gain} place${gain === 1 ? '' : 's'}` +
              (passed.length ? `, past ${passed.slice(0, 2).map((p) => `**${p.psn_online_id}**`).join(' and ')}.` : '.')
            : `-# Finishing the top 3 keeps you at **${ordinal(member.rank)}** — nobody close enough to catch.`,
        ),
        row(
          button('Nearly done', 'bl:nearly'),
          button('Quickest wins', 'bl:quick'),
          button('Rarest first', 'bl:rare'),
        ),
      ],
      COLOR.green,
    ),
  ]);
}

// ------------------------------------------------------------ components ---

async function handleComponent(interaction, env, ctx) {
  const [action, arg] = interaction.data.custom_id.split(':');
  const userId = interaction.member?.user?.id ?? interaction.user?.id;

  switch (action) {
    case 'lb': {
      if (arg === 'me') {
        const me = await db.memberByDiscordId(env, userId);
        const page = Math.max(1, Math.ceil((me?.rank ?? 1) / Number(env.LEADERBOARD_PAGE_SIZE ?? 10)));
        return { ...update((await leaderboard(env, page, userId)).data.components) };
      }
      return { ...update((await leaderboard(env, Number(arg), userId)).data.components) };
    }
    case 'bl':
      return { ...update((await backlog(env, userId, arg)).data.components) };
    case 'profile':
      return rank(env, arg);
    case 'rank':
      return rank(env, arg);
    // /rank answers privately so a hundred members don't bury the channel in
    // each other's numbers. This is the opt-in: same cards, posted for real.
    case 'share': {
      const shared = await rank(env, interaction.data.custom_id.split(':')[2] || userId);
      if (shared.data?.flags) shared.data.flags &= ~64; // clear ephemeral
      shared.data.components = shared.data.components.filter(
        (c) => !(c.type === 1 && c.components?.some((b) => b.custom_id?.startsWith('share:'))),
      );
      return shared;
    }
    case 'do':
      return runUpdate(interaction, env, ctx, userId);
    case 'owners': {
      const list = await db.gameOwnerList(env, arg, 15);
      return reply(
        [container([text(`### Played by\n${list.map((o) => `${o.progress === 100 ? '✅' : '▫️'} **${o.psn_online_id}** — ${o.progress}%`).join('\n')}`)], COLOR.orange)],
        { ephemeral: true },
      );
    }
    case 'changelog':
      return errorReply('Open the thread on the update message for the full changelog.');
    default:
      return errorReply('That button has expired.');
  }
}

/** Game title autocomplete, straight out of the shared cache. */
async function handleAutocomplete(interaction, env) {
  const focused = interaction.data.options?.find((o) => o.focused)?.value ?? '';
  const games = await db.searchGames(env, focused, 25);
  return {
    type: REPLY.AUTOCOMPLETE,
    data: { choices: games.map((g) => ({ name: g.title.slice(0, 100), value: g.title.slice(0, 100) })) },
  };
}

// -------------------------------------------------------------- dispatch ---

/** Hand the slow work to GitHub Actions, which has no subrequest cap. */
async function dispatchScan(env, discordId, interactionToken, extra = {}) {
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'platinum-intel-bot',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      event_type: 'trophy-scan',
      client_payload: { discord_id: discordId, interaction_token: interactionToken, ...extra },
    }),
  });
  if (!res.ok) console.error(`Dispatch failed (${res.status}): ${await res.text()}`);
}
