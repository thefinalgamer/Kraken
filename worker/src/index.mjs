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
  trophyLine, FALLBACK_AVATAR, TIERS, tierFor,
} from '../../shared/ui.mjs';
import { trophyPoints, rarityBand, RARITY_BANDS, applyCompletion } from '../../shared/scoring.mjs';

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
    case 'addmember':  return addMember(interaction, env, ctx, opt('member'), opt('psn-id'));
    case 'update':     return runUpdate(interaction, env, ctx, userId);
    case 'rank':       return rank(env, opt('member') ?? userId);
    case 'leaderboard':return leaderboard(env, 'me', userId);
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

  // Which queue this member is actually standing in. A first-timer waits behind
  // other first-timers; everyone else waits behind other repeat updates. The
  // two never block each other, which is the entire point of the split.
  const lane = laneFor(member);
  const firstScan = lane === 'first';

  // Only scans in YOUR lane are ahead of you. Counting the other lane's
  // three-hour first scan against a two-minute refresh is how a queue estimate
  // becomes a lie.
  const active = (await db.activeScans(env)).filter(
    (s) => s.psn_online_id !== member.psn_online_id && Boolean(s.first_scan) === firstScan,
  );

  let body = firstScan
    ? `## ${member.psn_online_id} first scan queued\n\n` +
      `This one reads your whole library, so it takes a while — anything from a few ` +
      `minutes to a couple of hours if you own thousands of games. Every update after ` +
      `this is two or three minutes.\n\nYou can close Discord; it carries on without you.`
    : `## ${member.psn_online_id} update queued\n\nScanning PSN now — this message will fill itself in.`;

  if (active.length) {
    const ahead = active[0];
    const mins = Math.max(1, Math.round((Date.now() - ahead.started_at) / 60000));

    // The database only knows about scans that have STARTED. Anyone waiting
    // behind them is queued at GitHub, invisible from here — so ask GitHub.
    // Without this, the twelfth person in line is told "one person is ahead of
    // you", waits an hour, and reasonably concludes the bot is broken.
    const waiting = await queueDepth(env, lane);
    const position = Math.max(active.length, waiting) + 1;
    // First scans are the long ones; repeat updates are 2-4 minutes.
    const eta = position * (firstScan ? 25 : 3);

    body =
      `## ${member.psn_online_id} update queued\n\n` +
      `**${ahead.psn_online_id}** is scanning right now — ${mins} minute${mins === 1 ? '' : 's'} in.\n\n` +
      (position > 1
        ? `You're **${ordinal(position)}** in the ${firstScan ? 'first-scan ' : ''}queue, so roughly ` +
          `**${eta} minutes**${firstScan ? ' — big libraries take longer' : ''}.\n\n`
        : `You're next.\n\n`) +
      `This message will fill itself in when it's your turn. Nothing's broken — scans run one ` +
      `at a time so nobody trips PlayStation's rate limit. ` +
      (firstScan
        ? 'First scans have their own queue, so you are not stuck behind anyone doing a quick refresh.'
        : 'Quick refreshes have their own queue, so you are never stuck behind somebody\'s first scan.');
  }

  // Private, wherever they ran it. The finished card goes to #updates instead —
  // so someone hammering /update in #general fills #updates, not the channel
  // people are trying to talk in.
  return reply([container([text(body)], active.length ? COLOR.orange : COLOR.grey)], {
    ephemeral: true,
  });
}

/**
 * How many scans are queued or running, straight from GitHub Actions.
 *
 * GitHub is the actual queue — `concurrency: queue: max` holds pending runs
 * there, and D1 never sees them because a row is only written once a scan
 * starts. Returns 0 on any failure: a wrong queue estimate is a far smaller
 * problem than /update falling over because the GitHub API had a moment.
 */
async function runsInWorkflow(env, file, timeoutMs = 800) {
  try {
    // HARD TIMEOUT. Discord gives an interaction three seconds, total. This
    // call is a nicety — it turns "queued" into "you're 4th, about 12 minutes"
    // — and a nicety must never be allowed to blow the deadline for the reply
    // itself. If GitHub is slow, we say nothing rather than saying nothing at
    // all, which is what a missed deadline actually looks like to the member:
    // "Kraken didn't respond in time".
    const res = await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${file}/runs` +
        `?per_page=30&exclude_pull_requests=true`,
      {
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'platinum-intel-bot',
        },
      },
    );
    if (!res.ok) return null;
    const { workflow_runs = [] } = await res.json();
    return workflow_runs.filter((r) => r.status === 'queued' || r.status === 'in_progress').length;
  } catch {
    // null, not 0 — "I could not find out" and "nothing is running" lead to
    // opposite decisions in chooseLane(), and conflating them is how an
    // unreachable GitHub turns into a first scan stuck behind five updates.
    return null;
  }
}

/**
 * How many scans are queued or running in a lane, straight from GitHub Actions.
 *
 * GitHub is the actual queue — `concurrency: queue: max` holds pending runs
 * there, and D1 never sees them because a row is only written once a scan
 * starts. Returns 0 on any failure: a wrong queue estimate is a far smaller
 * problem than /update falling over because the GitHub API had a moment.
 */
const queueDepth = async (env, lane = 'update') =>
  (await runsInWorkflow(env, lane === 'first' ? 'scan-first.yml' : 'scan.yml')) ?? 0;

/**
 * Your position, plus whoever is directly above and below you.
 *
 * One either side, not two: five cards is a wall rather than an answer, and the
 * two extra were people nobody is racing. Knowing who is four hundred points
 * behind and closing motivates as much as knowing who you are chasing.
 */
async function rank(env, target) {
  const member = await db.memberByDiscordId(env, target);
  if (!member) return errorReply('That member is not on the board yet.');

  const neighbours = await db.neighbours(env, member.rank ?? 1, 1);
  // rankedCount, not memberCount. memberCount includes anyone registered but
  // mid-first-scan, which made /rank say "4th of 6" while the board underneath
  // it said "5 hunters" — and fed a wrong total into the tier boundaries.
  const total = await db.rankedCount(env);
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
        button('Who\'s near me', 'lb:me'),
        button('Refresh my stats', 'do:update', STYLE.PRIMARY),
        button('Share to channel', `share:rank:${target}`, STYLE.SECONDARY),
      ),
    ],
    { ephemeral: true },
  );
}

/**
 * Who is near you.
 *
 * NOT a copy of the board. The full ranking lives in #leaderboard, edits itself
 * in place and shows everybody — so repeating it here paginated was answering a
 * question nobody was asking. What you actually want mid-conversation is the
 * five people you are chasing and the five closing on you.
 *
 * Ephemeral, like everything except the board itself, with a link to hand you
 * back to the real thing.
 */
async function leaderboard(env, mode, viewerId) {
  const total = await db.rankedCount(env);
  if (!total) return errorReply('Nobody is on the board yet.');

  const me = await db.memberByDiscordId(env, viewerId);
  const myRank = me?.rank ?? null;

  // Centre the window, then pull it back inside the board so you always get a
  // full eleven where there are eleven to give — otherwise being 2nd or last
  // shows you a stub.
  const wanted = mode === 'top' || !myRank ? 6 : myRank;
  const centre = Math.min(Math.max(6, wanted), Math.max(6, total - 5));
  const rows = await db.neighbours(env, centre, 5);

  const openBoard =
    env.DISCORD_GUILD_ID && env.DISCORD_LEADERBOARD_CHANNEL_ID
      ? [linkButton(
          'Open #leaderboard',
          `https://discord.com/channels/${env.DISCORD_GUILD_ID}/${env.DISCORD_LEADERBOARD_CHANNEL_ID}`,
        )]
      : [];

  const heading =
    mode === 'top' || !myRank
      ? `# Top of the board\n-# ${n(total)} hunters · rarity points × completion`
      : `# Around you\n-# ${ordinal(myRank)} of ${n(total)} · five either side`;

  return reply(
    [
      text(heading),
      ...boardBlocks(rows, { total, viewerId }),
      row(
        button('Top of the board', 'lb:top', STYLE.SECONDARY),
        ...(myRank ? [button('Around me', 'lb:me', STYLE.PRIMARY)] : []),
        ...openBoard,
      ),
    ],
    { ephemeral: true },
  );
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
  // What the whole game is worth at 100%, and what this member has taken out of
  // it so far. Martin: "i want it saying you have x amount out of x amount so
  // people can see how much the games worth still." A bare "worth to you"
  // figure answers what is left without ever saying what it is left OF, so a
  // big number and a nearly-finished game look identical.
  const fullValue = trophies.reduce((sum, t) => sum + (t.points || 0), 0);
  const banked = fullValue - worth;
  const plat = trophies.find((t) => t.type === 'platinum');

  // PSN has told us nothing about this game — either it is old enough that Sony
  // stopped computing rarity, or new enough that it hasn't started. Its points
  // are estimates, and the card must say so. Rendering an unknown as
  // "0.00% earned · Ultra rare" is the worst of both: it looks like hard data
  // AND it claims the rarest band on PlayStation for a trophy we know nothing
  // about.
  const estimated = !trophies.some((t) => Number(t.earned_rate) > 0);

  const rarityOf = (t) =>
    Number(t.earned_rate) > 0
      ? `${pct(t.earned_rate)} earned · ${RARITY_BANDS[rarityBand(t.earned_rate)]}` +
        (found.local_started > 0 ? ` · ${n(t.local_earned ?? 0)}/${n(found.local_started)} here` : '')
      : 'rarity not published · estimated';

  const top = [...remaining]
    .sort((a, b) => (b.points || 0) - (a.points || 0))
    .slice(0, 3)
    .map(
      (t, i) =>
        // `name` is null until the scan has backfilled it — see backfillNames()
        // in jobs/scan.mjs. Printing it raw is where "1. null · bronze" came
        // from. A game gets its names on the next scan that touches it, so this
        // fallback is temporary for any given game but must never render null.
        `**${i + 1}.** ${t.name || `Trophy #${t.trophy_id}`} · *${t.type}*\n` +
        `-# ${rarityOf(t)} · **+${n(t.points)} point${t.points === 1 ? '' : 's'}**`,
    );

  const owners = await db.gameOwners(env, found.np_comm_id);

  return reply(
    [
      container(
        [
          section(
            [
              `## ${found.title}\n-# ${found.platform ?? 'PlayStation'} · ${n(found.trophy_count)} trophies`,
              `**Worth to you:** ${n(banked)} of ${n(fullValue)} points earned` +
                (worth > 0 ? `\n-# ${n(worth)} still on the table` : '') +
                (mine ? `\n**Your progress:** ${mine.progress}%` : '\n**Your progress:** not started'),
              plat
                ? `**Plat rarity:** ${Number(plat.earned_rate) > 0
                    ? `${pct(plat.earned_rate)} · ${RARITY_BANDS[rarityBand(plat.earned_rate)]}`
                    : 'not published by PSN'}`
                : '',
            ].filter(Boolean),
            thumbnail(found.icon_url || FALLBACK_AVATAR, found.title),
          ),
          separator(),
          text(['**Biggest earners left**', ...top].join('\n')),
          separator(),
          ...(estimated
            ? [text(
                '-# **PSN has not published rarity for this game.** Every value above is an ' +
                  'estimate — what a typical trophy is worth — and is deliberately on the low ' +
                  'side, because guessing high is how a leaderboard gets farmed. New releases ' +
                  'usually get real figures within a few weeks and this corrects itself.',
              )]
            : []),
          text(
            `-# ${n(owners.completed)} of ${n(owners.total)} members here have 100%'d this` +
              (owners.fastest ? ` · first was **${owners.fastest}**` : ''),
          ),
          // Local rarity is invisible unless the card says it out loud — the
          // points just quietly differ from what PSNProfiles would tell you,
          // and that reads as a bug rather than as the system working.
          // Layer two, said out loud. Without this the points just quietly
          // differ from PSNProfiles and it reads as a bug rather than as the
          // best part of the system.
          ...(found.local_started > 1
            ? [text(
                `-# **${n(found.local_started)}** members here own this. Every trophy is worth ` +
                  'more while people are still stuck on it, and settles back to its normal ' +
                  'value once everyone who owns it has finished — so somebody else picking ' +
                  'this up right now makes it worth more to you.',
              )]
            : []),
          row(button("Who's played it", `owners:${found.np_comm_id}`)),
        ],
        COLOR.blurple,
      ),
    ],
    { ephemeral: true },
  );
}

const SORT_LABEL = {
  value: 'biggest prize first',
  nearly: 'closest to finished first',
  quick: 'most points per trophy left',
  rare: 'rarest platinum first',
};

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

  // Worth TO THIS MEMBER, not the game's raw worth. `remaining_points` is the
  // rarity value; what actually lands in their score is that multiplied by
  // their completion. Showing the raw figure would promise a 70.41% member 249
  // points and then pay them 175 — on the one card in the whole bot whose job
  // is to make finishing things look worth doing.
  //
  // Still an UNDERSTATEMENT, and deliberately so: finishing a game also lifts
  // completion, which re-prices the entire library. We can't price that here
  // without storing the completion numerator and denominator, so the card
  // promises the floor and the update pays more. Better that way round.
  const worth = (raw) => applyCompletion(raw, member.completion);

  const lines = rows.map((g, i) => {
    const band = g.plat_rate != null ? ` · ${RARITY_BANDS[rarityBand(g.plat_rate)]}` : '';
    const value = worth(g.remaining_points);
    return (
      `**${i + 1}. ${g.title}** — +${n(value)} point${value === 1 ? '' : 's'}\n` +
      `-# ${n(g.remaining_trophies)} troph${g.remaining_trophies === 1 ? 'y' : 'ies'} left · ${g.progress}% done${band}`
    );
  });

  // The line that makes it more than a to-do list.
  const projected = member.points + rows.slice(0, 3).reduce((s, g) => s + worth(g.remaining_points), 0);
  const wouldBe = await db.rankForPoints(env, projected);
  const gain = (member.rank ?? 0) - wouldBe;
  const passed = gain > 0 ? await db.membersBetween(env, wouldBe, member.rank) : [];

  return reply(
    [
      container(
        [
          text(
            `## ${member.psn_online_id}'s backlog\n` +
              `-# ${n(member.projects - member.completed)} unfinished · ${SORT_LABEL[sort] ?? SORT_LABEL.value}\n\n` +
              lines.join('\n\n'),
          ),
          separator(),
          text(
            gain > 0
              ? `-# Finishing the top 3 would put you at **${ordinal(wouldBe)}** — up ${gain} place${gain === 1 ? '' : 's'}` +
                (passed.length ? `, past ${passed.slice(0, 2).map((p) => `**${p.psn_online_id}**`).join(' and ')}.` : '.')
              : `-# Finishing the top 3 keeps you at **${ordinal(member.rank)}** — nobody close enough to catch.`,
          ),
          ...(member.completion < 100
            ? [text(
                `-# Worth at your ${pct(member.completion)} completion — and finishing these raises it, ` +
                  'so every other game you own pays more too.',
              )]
            : []),
          // All four sorts, with the one you're looking at highlighted. The
          // default had no button at all, so clicking any of the others was a
          // one-way trip — you could never get back to the biggest-prize list
          // without running the command again.
          row(
            ...[
              ['Biggest prize', 'value'],
              ['Nearly done', 'nearly'],
              ['Best value', 'quick'],
              ['Rarest first', 'rare'],
            ].map(([label, key]) =>
              button(label, `bl:${key}`, key === (sort ?? 'value') ? STYLE.PRIMARY : STYLE.SECONDARY),
            ),
          ),
        ],
        COLOR.green,
      ),
      // Private, like everything else except the board itself. #leaderboard is
      // the one public surface; a hundred members running /backlog in #general
      // would bury the conversation the server exists for.
    ],
    { ephemeral: true },
  );
}

/**
 * A member's profile — the stuff that doesn't fit on a leaderboard row.
 *
 * Used to just re-render /rank, which was pointless when you had clicked it
 * FROM /rank. What people actually want to know about somebody is not their
 * position, which they can already see, but what they have done: the rarest
 * thing they own, their best game, what they have been finishing lately.
 *
 * And when you look at someone else, the most useful section is the last one —
 * games you BOTH own where they are further ahead. That turns "they are better
 * than me" into "here are four games where they know something I don't", which
 * is the seed of the co-op idea.
 */
async function profile(env, targetId, viewerId) {
  const m = await db.memberByDiscordId(env, targetId);
  if (!m) return errorReply('That member is not on the board yet.');

  const total = await db.rankedCount(env);
  const tier = TIERS[tierFor(m.rank, total)];
  const [best, finished] = await Promise.all([
    db.bestGame(env, m.psn_account_id),
    db.recentlyFinished(env, m.psn_account_id),
  ]);

  const lines = [
    // "4th — Silver". The "of 5" was noise: the leaderboard already says how
    // many people are on it, and a card should read like a name badge.
    `**${ordinal(m.rank)}** — ${tier.name}`,
    `**Points** ${n(m.points)}  ·  **Completion** ${pct(m.completion)}`,
    `**Games** ${n(m.projects)} started, ${n(m.completed)} finished`,
  ];

  // Show the working. The score is rarity points x completion, and a member who
  // can see both halves understands instantly why finishing old games pays —
  // which no amount of explaining in #rules ever achieves.
  if (m.raw_points > 0 && m.completion < 100) {
    lines.push(
      `-# ${n(m.raw_points)} rarity points × ${pct(m.completion)} completion. ` +
        `${n(m.raw_points - m.points)} still waiting in the backlog.`,
    );
  }

  if (m.rarest_name || m.rarest_game) {
    lines.push(
      `**Rarest owned** ${Number(m.rarest_rate).toFixed(2)}%` +
        (m.rarest_game ? ` — ${m.rarest_game}` : ''),
    );
  }
  if (best) lines.push(`**Best game** ${best.title} — ${n(best.points)} pts at ${best.progress}%`);

  const blocks = [
    container(
      [
        section(
          [`## ${m.psn_online_id}`, trophyLine(m), lines.join('\n')],
          thumbnail(m.avatar_url || FALLBACK_AVATAR, m.psn_online_id),
        ),
      ],
      tier.color,
    ),
  ];

  if (finished.length) {
    blocks.push(
      container(
        [text(`### Recently finished\n${finished.map((f) => `✅ ${f.title}`).join('\n')}`)],
        COLOR.green,
      ),
    );
  }

  // Only when looking at somebody else, and only if you actually overlap.
  if (viewerId && viewerId !== targetId) {
    const me = await db.memberByDiscordId(env, viewerId);
    if (me?.psn_account_id) {
      const ahead = await db.aheadOfMe(env, m.psn_account_id, me.psn_account_id);
      if (ahead.length) {
        blocks.push(
          container(
            [
              text(
                `### Where they're ahead of you\n` +
                  ahead
                    .map((a) => `▫️ **${a.title}** — them ${a.their_progress}%, you ${a.my_progress}%`)
                    .join('\n'),
              ),
            ],
            COLOR.orange,
          ),
        );
      }
    }
  }

  blocks.push(
    row(button('Their rank', `rank:${targetId}`), button('Who\'s near me', 'lb:me')),
  );

  return reply(blocks, { ephemeral: true });
}

// ------------------------------------------------------------ components ---

async function handleComponent(interaction, env, ctx) {
  // `share:rank:123` has two colons, so the rest is kept intact rather than
  // split away and lost.
  const [action, ...rest] = interaction.data.custom_id.split(':');
  const arg = rest.join(':');
  const userId = interaction.member?.user?.id ?? interaction.user?.id;

  switch (action) {
    case 'lb':
      // 'top' or anything else means the head of the board; 'me' re-centres on
      // the caller. Older buttons carried a page number, which now harmlessly
      // falls through to the top.
      return {
        ...update((await leaderboard(env, arg === 'me' ? 'me' : 'top', userId)).data.components),
      };
    case 'bl':
      return { ...update((await backlog(env, userId, arg)).data.components) };
    case 'profile':
      return profile(env, arg, userId);
    case 'rank':
      return rank(env, arg);
    case 'do':
      return runUpdate(interaction, env, ctx, userId);
    case 'share': {
      // The escape hatch from everything being private: /rank is ephemeral, so
      // this is how you put your card in the channel deliberately rather than
      // by default.
      const [, target] = arg.split(':');
      const card = await rank(env, target || userId);
      return { type: REPLY.MESSAGE, data: { ...card.data, flags: 32768 } };
    }
    case 'owners': {
      const list = await db.gameOwnerList(env, arg, 15);
      return reply(
        [
          container(
            [
              text(
                `### Played by\n${list
                  .map((o) => `${o.progress === 100 ? '✅' : '▫️'} **${o.psn_online_id}** — ${o.progress}%`)
                  .join('\n')}`,
              ),
            ],
            COLOR.orange,
          ),
        ],
        { ephemeral: true },
      );
    }
    case 'changelog':
      return changelog(env, Number(arg));
    default:
      return errorReply('That button has expired.');
  }
}

/** What actually changed in an update, straight from the database. */
async function changelog(env, updateId) {
  const rows = await db.changelogFor(env, updateId);
  if (!rows.length) {
    return reply(
      [
        container(
          [
            text(
              `### Nothing changed in Update No. ${updateId}\n\n` +
                `No new trophies since the previous scan, so there's nothing to list. ` +
                `Your points can still move on an update like this — trophies you already ` +
                `own shift in rarity as other players earn them.`,
            ),
          ],
          COLOR.grey,
        ),
      ],
      { ephemeral: true },
    );
  }

  const total = await db.changelogCount(env, updateId);
  const icon = { new: '🆕', completed: '✅', progress: '📈' };
  const lines = rows.map((c) => {
    const what =
      c.kind === 'new'
        ? `started (${c.progress_to}%)`
        : `${c.progress_from}% → ${c.progress_to}%`;
    const gained = c.trophies_gained > 0 ? ` · +${n(c.trophies_gained)} trophies` : '';
    const worth = c.points_gained > 0 ? ` · +${n(c.points_gained)} pts` : '';
    return `${icon[c.kind] ?? '•'} **${c.title}** — ${what}${gained}${worth}`;
  });

  // Ruthless about length. A first scan can change thousands of games and
  // Discord allows 4,000 characters, so build up to the limit and stop.
  const kept = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > 3400) break;
    kept.push(line);
    used += line.length + 1;
  }
  const hidden = total - kept.length;

  return reply(
    [
      container(
        [
          text(`### Update No. ${updateId} — what changed`),
          text(kept.join('\n')),
          text(
            hidden > 0
              ? `-# Showing the ${kept.length} most valuable of ${n(total)} games changed.`
              : `-# ${n(total)} game${total === 1 ? '' : 's'} changed.`,
          ),
        ],
        COLOR.blurple,
      ),
    ],
    { ephemeral: true },
  );
}

async function handleAutocomplete(interaction, env) {
  const focused = String(interaction.data.options?.find((o) => o.focused)?.value ?? '').trim();

  // Empty box: offer their own library rather than the shortest titles in the
  // database, which is what produced a dropdown of "%" and "67".
  let games = [];
  if (!focused) {
    const userId = interaction.member?.user?.id ?? interaction.user?.id;
    const me = userId ? await db.memberByDiscordId(env, userId) : null;
    if (me?.psn_account_id) games = await db.myRecentGames(env, me.psn_account_id, 25);
  }
  if (!games.length) games = await db.searchGames(env, focused, 25);
  return {
    type: REPLY.AUTOCOMPLETE,
    data: { choices: games.map((g) => ({ name: g.title.slice(0, 100), value: g.title.slice(0, 100) })) },
  };
}

// -------------------------------------------------------------- dispatch ---

/**
 * Put someone on the board by hand, skipping verification. Mods only.
 *
 * Verification exists so nobody can claim somebody else's PSN account, and
 * bypassing it is a real decision rather than a convenience — so it is recorded
 * as `grandfathered`, and the reply says plainly that no proof was taken. When
 * a mod adds twenty friends at launch, that is exactly what happened, and the
 * database should not pretend otherwise.
 *
 * The first scan still has to succeed: the PSN online ID is only a string until
 * Sony confirms an account by that name exists and is public. A typo here does
 * not create a fake member, it creates a member whose first scan fails loudly.
 */
async function addMember(interaction, env, ctx, targetId, psnId) {
  const actor = interaction.member?.permissions ?? '0';
  if ((BigInt(actor) & 32n) !== 32n) {
    return errorReply('That command is for mods.');
  }

  const cleanId = String(psnId ?? '').trim();
  if (!/^[A-Za-z0-9_-]{3,16}$/.test(cleanId)) {
    return errorReply(
      `**${cleanId}** does not look like a PSN online ID. They are 3-16 characters, ` +
        'letters, numbers, hyphens and underscores only.',
    );
  }

  const existing = await db.memberByDiscordId(env, targetId);
  if (existing) {
    return errorReply(
      `<@${targetId}> is already on the board as **${existing.psn_online_id}**. ` +
        'Use `/unlink` first if it needs changing.',
    );
  }

  const taken = await db.claimBlockedBy(env, cleanId);
  if (taken) {
    return errorReply(`**${cleanId}** is already claimed by <@${taken.discord_id}>.`);
  }

  await db.createVerifiedMember(env, { discordId: targetId, onlineId: cleanId });
  ctx.waitUntil(dispatchScan(env, targetId, null, { first: true }));

  return reply(
    [
      container(
        [
          text(
            `## ${cleanId} added\n\n` +
              `<@${targetId}> is on the board and their first scan is queued. It reads their ` +
              `whole library, so it can take a while — the result lands in ` +
              `<#${env.DISCORD_UPDATES_CHANNEL_ID}>.\n\n` +
              `-# Added by a mod, so no PSN ownership check was done — recorded as ` +
              `\`grandfathered\`. If the name is misspelled the scan will fail rather than ` +
              `score the wrong person; \`/unlink\` and try again.`,
          ),
        ],
        COLOR.green,
      ),
    ],
    { ephemeral: true },
  );
}

/**
 * Which lane a member's scan belongs in.
 *
 * TWO QUEUES, and the reason is arithmetic. Every scan logs in as the same PSN
 * account, so they cannot all run at once — but a single queue means a
 * newcomer's three-hour first scan sits in front of everyone who just wants to
 * refresh. With ~100 people arriving, all of them needing a first scan, one
 * queue is days long and person number sixty is told they are sixtieth and
 * leaves.
 *
 * So: first scans get their own lane and never block anybody. A repeat update
 * is two to four minutes because only games whose trophy count actually moved
 * are re-fetched.
 *
 * This is the single source of truth for the rule. db.activeScans() derives the
 * same thing in SQL for the queue message; keep them agreeing.
 */
const laneFor = (member) => (member?.last_update_at ? 'update' : 'first');

/**
 * Which lane to actually FIRE this scan into — which is not always the lane the
 * member belongs to.
 *
 * Martin's rule: both lanes should chew through updates when no first scan is
 * happening, and a first scan arriving should wait out the update in front of
 * it and then go next.
 *
 * That falls out of one decision made here. A repeat update prefers its own
 * lane, but when the fast lane is busy and the slow lane is completely idle it
 * borrows the slow lane instead — otherwise half the server's scanning capacity
 * sits doing nothing while people wait.
 *
 * "Completely idle" is doing the work. The moment a first scan is queued or
 * running, the slow lane stops taking overflow, so the most a first scan ever
 * waits behind is the one update already in flight — two to four minutes. No
 * reordering needed, and GitHub's queue is strictly FIFO so none is possible.
 *
 * On any GitHub failure this returns the member's own lane. Overflow is an
 * optimisation; the cost of getting it wrong is a first scan stuck behind a
 * pile of updates, and the cost of skipping it is a slightly longer wait.
 */
async function chooseLane(env, member) {
  const own = laneFor(member);
  if (own === 'first') return 'first';

  const [fast, slow] = await Promise.all([
    // Generous timeouts: this runs in waitUntil, after the member already has
    // their reply, so it is not on the three-second interaction deadline.
    runsInWorkflow(env, 'scan.yml', 3000),
    runsInWorkflow(env, 'scan-first.yml', 3000),
  ]);

  if (fast === null || slow === null) return 'update';
  return fast > 0 && slow === 0 ? 'first' : 'update';
}

/** Hand the slow work to GitHub Actions, which has no subrequest cap. */
async function dispatchScan(env, discordId, interactionToken, extra = {}) {
  const member = await db.memberByDiscordId(env, discordId);
  const lane = await chooseLane(env, member);

  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'platinum-intel-bot',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      // Separate event types rather than one with a lane flag, because GitHub
      // concurrency groups are per WORKFLOW — two files is what actually buys
      // two independent queues. `lane` here is the lane being FIRED INTO, which
      // for an overflowing update is not the lane it belongs to.
      event_type: lane === 'first' ? 'trophy-first-scan' : 'trophy-scan',
      client_payload: {
        discord_id: discordId, interaction_token: interactionToken, lane, ...extra,
      },
    }),
  });
  if (!res.ok) console.error(`Dispatch failed (${res.status}): ${await res.text()}`);
}
