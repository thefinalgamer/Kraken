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
import {
  message, container, text, section, thumbnail, row, button, separator,
  memberCard, configureEmoji, COLOR, STYLE, n, pct, ordinal, trophyLine, FALLBACK_AVATAR,
} from '../../shared/ui.mjs';
import { trophyPoints, rarityBand, RARITY_BANDS } from '../../shared/scoring.mjs';

const TYPE = { PING: 1, COMMAND: 2, COMPONENT: 3, AUTOCOMPLETE: 4 };
const REPLY = { PONG: 1, MESSAGE: 4, DEFER: 5, UPDATE_MESSAGE: 7, AUTOCOMPLETE: 8 };

export default {
  async fetch(request, env, ctx) {
    // Worker config arrives via the env binding, not process.env.
    configureEmoji(env);

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
  if (existing) {
    return errorReply(
      `You're already registered as **${existing.psn_online_id}**. ` +
        'Ask a mod if you need it changed.',
    );
  }

  const taken = await db.memberByOnlineId(env, psnId);
  if (taken) return errorReply(`**${psnId}** is already claimed by someone else here.`);

  // The Worker has no PSN credentials, so the scan job resolves and validates
  // the account. We store a provisional row and let the first scan fill it in.
  await db.createProvisionalMember(env, { discordId: userId, onlineId: psnId });

  ctx.waitUntil(dispatchScan(env, userId, interaction.token, { first: true }));

  return reply([
    container(
      [
        text(
          `## Welcome to Platinum Intel\n\n` +
            `Linking **${psnId}** and running your first scan now.\n\n` +
            `First scans are the slow ones — **15 to 30 minutes** — because nothing about ` +
            `your library is cached yet. Every update after this takes 2 to 3.\n\n` +
            `-# If nothing happens, your PSN trophies are probably set to private. ` +
            `Settings → Users and Accounts → Privacy → Trophies → **Anyone**.`,
        ),
      ],
      COLOR.green,
    ),
  ]);
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
    body =
      `## ${member.psn_online_id} update queued\n\n` +
      `**${ahead.psn_online_id}** is scanning right now — ${mins} minute${mins === 1 ? '' : 's'} in` +
      (active.length > 1 ? `, with ${active.length - 1} more waiting` : '') +
      `.\n\nYours starts when theirs finishes, and this message will fill itself in. ` +
      `Nothing's broken — scans run one at a time so nobody trips PlayStation's rate limit.`;
  }

  return reply([container([text(body)], active.length ? COLOR.orange : COLOR.grey)]);
}

async function rank(env, target) {
  const member = await db.memberByDiscordId(env, target);
  if (!member) return errorReply('That member is not on the board yet.');

  // Your position plus the people either side — the view members actually want,
  // since they care about whoever they're chasing, not about first place.
  const neighbours = await db.neighbours(env, member.rank ?? 1, 2);
  const total = await db.memberCount(env);
  const cards = neighbours.map((m) =>
    memberCard(m, { total, highlight: m.discord_id === member.discord_id }),
  );
  return reply([
    text(`**${member.psn_online_id}** — ${ordinal(member.rank)} of ${n(total)}`),
    ...cards,
    row(
      button('Full leaderboard', `lb:${Math.max(1, Math.ceil((member.rank ?? 1) / 10))}`),
      button('Refresh my stats', 'do:update', STYLE.PRIMARY),
    ),
  ]);
}

async function leaderboard(env, page, viewerId) {
  const size = Number(env.LEADERBOARD_PAGE_SIZE ?? 10);
  const total = await db.memberCount(env);
  const pages = Math.max(1, Math.ceil(total / size));
  const safePage = Math.min(Math.max(1, page), pages);
  const members = await db.leaderboardPage(env, (safePage - 1) * size, size);

  return reply([
    text(`## Platinum Intel\n-# Ranked by rarity points · page ${safePage} of ${pages} · ${n(total)} hunters`),
    ...members.map((m) => memberCard(m, { total, highlight: m.discord_id === viewerId })),
    row(
      button('◀ Prev', `lb:${safePage - 1}`, STYLE.SECONDARY, { disabled: safePage <= 1 }),
      button('Next ▶', `lb:${safePage + 1}`, STYLE.SECONDARY, { disabled: safePage >= pages }),
      button('Jump to me', 'lb:me', STYLE.PRIMARY),
    ),
  ]);
}

/**
 * The website's scan feature, brought into Discord — except it knows who is
 * asking, so it shows what the game is worth to YOU with anything already
 * earned subtracted.
 */
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
