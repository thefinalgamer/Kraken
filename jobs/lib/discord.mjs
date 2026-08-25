/**
 * Discord REST posting from the scan job.
 *
 * The Worker replies to the interaction instantly with "queued", then this
 * edits that same message once the scan finishes — so the member sees one
 * message that fills itself in, rather than a wall of bot spam.
 */

import { HOME_BLURB, faqOptions } from '../../shared/faq.mjs';
import {
  configureEmoji,
  tierFor,
  message,
  updateCard,
  movementLines,
  container,
  text,
  boardBlocks,
  projectBlocks,
  selectMenu,
  linkButton,
  separator,
  section,
  thumbnail,
  chunkBoard,
  row,
  n,
  COLOR,
} from '../../shared/ui.mjs';

const API = 'https://discord.com/api/v10';
const env = process.env;

// The job half reads config from process.env; the Worker half uses its env
// binding. Both must configure the emoji before rendering anything.
configureEmoji(env);

async function rest(path, { method = 'POST', body, useBotToken = true } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(useBotToken ? { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 429) {
    const retry = (await res.json().catch(() => ({}))).retry_after ?? 1;
    await new Promise((r) => setTimeout(r, (retry + 0.5) * 1000));
    return rest(path, { method, body, useBotToken });
  }
  if (!res.ok) {
    throw new Error(`Discord ${method} ${path} failed (${res.status}): ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

/**
 * Publish a finished update.
 *
 * The result ALWAYS goes to #updates, whichever channel the member happened to
 * run /update in. Martin's call, and the right one: someone spamming /update in
 * #general used to spam #general, and with a hundred members that is how a chat
 * channel dies. Now the noise lands in the channel that exists for it, and the
 * person who ran the command gets a private pointer wherever they are.
 *
 * It also fixes something that was quietly broken: the changelog thread hangs
 * off this message, and threads cannot be created on an ephemeral interaction
 * reply. Posting to a real channel first means the thread always has somewhere
 * to live.
 */
export async function postUpdateResult({ member, result, interactionToken }) {
  const body = message([
    container([text(`## ${member.psn_online_id} update finished!`)], COLOR.grey),
    updateCard({
      member,
      updateNo: result.updateNo,
      before: result.before,
      after: result.after,
      delta: result.delta,
      gamesChanged: result.gamesChanged,
      durationSeconds: result.durationSeconds,
      repaired: result.repaired,
    }),
  ]);

  const msg = await rest(`/channels/${env.DISCORD_UPDATES_CHANNEL_ID}/messages`, { body });

  if (result.changelog?.length && msg?.id) {
    await postChangelogThread(msg, member, result);
  }

  // Then a private nudge back to whoever ran it. Best-effort: the scan is
  // finished and saved, and a Discord hiccup here must not fail the job.
  if (interactionToken) {
    await pointAtUpdates(interactionToken, member, result, msg).catch((err) =>
      console.error('Could not update the private reply:', err.message),
    );
  }
  return msg;
}

/**
 * Edit the member's own (private) /update reply into a short pointer.
 *
 * A channel mention rather than a message link, because that needs no guild id
 * and Discord renders it as a proper clickable channel either way.
 */
async function pointAtUpdates(interactionToken, member, result, msg) {
  const net = result.delta?.net ?? 0;
  const sign = net >= 0 ? '+' : '';
  const line =
    `## Update finished\n\n` +
    `**${sign}${net.toLocaleString('en-GB')} points**` +
    (result.gamesChanged ? ` across ${result.gamesChanged} game${result.gamesChanged === 1 ? '' : 's'}` : '') +
    `.\n\nThe full card is in <#${env.DISCORD_UPDATES_CHANNEL_ID}>` +
    (msg?.id ? ' — click through for the breakdown and changelog.' : '.');

  await rest(
    `/webhooks/${env.DISCORD_APPLICATION_ID}/${interactionToken}/messages/@original`,
    { method: 'PATCH', body: message([container([text(line)], COLOR.green)]), useBotToken: false },
  );
}

/**
 * Tell the member their update failed.
 *
 * Without this a failed scan leaves the "queued" message sitting there forever
 * and the member has no idea anything went wrong — they just assume the bot is
 * broken and stop using it. A failure they can see and act on is worth far more
 * than a silent one buried in the Actions log.
 */
export async function postUpdateFailure({ member, updateNo, error, interactionToken }) {
  const isPrivate = error?.name === 'PsnPrivateError' || /not readable|private/i.test(error?.message ?? '');
  const notFound = /No PSN account called/i.test(error?.message ?? '');

  let body;
  if (isPrivate) {
    body =
      `## Couldn't read your trophies\n\n` +
      `**${member.psn_online_id}**'s trophy list isn't public, so PlayStation won't let ` +
      `Kraken see it.\n\n` +
      `**On your console:** Settings → Users and Accounts → Privacy → Trophies → **Anyone**\n` +
      `**On the web:** account settings on playstation.com, same option\n\n` +
      `Then run \`/update\` again. Nothing else needs doing.`;
  } else if (notFound) {
    body =
      `## No such PSN account\n\n` +
      `I couldn't find a PlayStation account called **${member.psn_online_id}**.\n\n` +
      `Check the spelling against your profile — it has to match exactly — and run ` +
      `\`/register\` again.`;
  } else {
    body =
      `## Update failed\n\n` +
      `Something went wrong scanning **${member.psn_online_id}**. This is a fault at ` +
      `Kraken's end, not yours.\n\n` +
      `\`\`\`\n${String(error?.message ?? 'Unknown error').slice(0, 300)}\n\`\`\`\n` +
      `Your existing stats are untouched. Try \`/update\` again in a few minutes — if it ` +
      `keeps failing, flag it to a mod.`;
  }

  const payload = message([
    container(
      [
        text(body),
        text(`-# Update No. ${updateNo} · ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`),
      ],
      COLOR.red,
    ),
  ]);

  try {
    if (interactionToken) {
      await rest(
        `/webhooks/${env.DISCORD_APPLICATION_ID}/${interactionToken}/messages/@original`,
        { method: 'PATCH', body: payload, useBotToken: false },
      );
    } else if (env.DISCORD_UPDATES_CHANNEL_ID) {
      await rest(`/channels/${env.DISCORD_UPDATES_CHANNEL_ID}/messages`, { body: payload });
    }
  } catch (err) {
    // Never let the error-reporter mask the original error.
    console.error('Could not post the failure card:', err.message);
  }
}

/**
 * The per-game changelog.
 *
 * The old bot posted one message per game — RabbitSquared's first scan fired
 * 280 of them, which is both slow and a hard shove into Discord's rate limits.
 * Same information, batched twenty games to a message.
 */
async function postChangelogThread(msg, member, result) {
  const thread = await rest(`/channels/${msg.channel_id}/messages/${msg.id}/threads`, {
    body: {
      name: `Update No. ${result.updateNo} (${member.psn_online_id})`,
      auto_archive_duration: 1440,
    },
  });

  const icon = { new: '🆕', completed: '✅', progress: '📈' };
  const lines = result.changelog
    .sort((a, b) => b.points_gained - a.points_gained)
    .map(
      (c) =>
        `${icon[c.kind] ?? '•'} **${c.title}** — ` +
        (c.kind === 'new'
          ? `started (${c.progress_to}%)`
          : `${c.progress_from}% → ${c.progress_to}%`) +
        (c.trophies_gained > 0 ? `, +${c.trophies_gained} trophies` : ''),
    );

  const CHUNK = 20;
  for (let i = 0; i < lines.length; i += CHUNK) {
    await rest(`/channels/${thread.id}/messages`, {
      body: message([
        container(
          [text(lines.slice(i, i + CHUNK).join('\n'))],
          i === 0 ? COLOR.blurple : COLOR.grey,
        ),
      ]),
    });
  }
}

/**
 * The movement feed — posted to #updates, NOT #leaderboard.
 *
 * #leaderboard holds the living board and nothing else: you glance at it, you
 * do not scroll it. Movement lines are news and belong with the update cards.
 */
export async function postMovements(movements) {
  const channel = env.DISCORD_UPDATES_CHANNEL_ID;
  if (!channel) return;
  const CHUNK = 15;
  for (let i = 0; i < movements.length; i += CHUNK) {
    await rest(`/channels/${channel}/messages`, {
      body: message([text(movementLines(movements.slice(i, i + CHUNK)))]),
    });
  }
}

/**
 * The one unavoidable chore. PSN's refresh token dies after about two months;
 * this pings the owner three days out so it never fails silently.
 */
export async function warnTokenExpiry(daysLeft) {
  if (!env.DISCORD_OWNER_ID) return;
  const dm = await rest('/users/@me/channels', { body: { recipient_id: env.DISCORD_OWNER_ID } });
  await rest(`/channels/${dm.id}/messages`, {
    body: message([
      container(
        [
          text(
            `## PSN login expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}\n\n` +
              `Updates will stop working when it does. Takes two minutes to fix:\n\n` +
              `1. Sign in at <https://www.playstation.com> in a browser\n` +
              `2. Visit <https://ca.account.sony.com/api/v1/ssocookie>\n` +
              `3. Copy the \`npsso\` value\n` +
              `4. Paste it into the repo's \`PSN_NPSSO\` secret on GitHub\n\n` +
              `-# This is the only manual step in the whole system — roughly six times a year.`,
          ),
        ],
        COLOR.red,
      ),
    ]),
  });
}


// ------------------------------------------------------- the living board --

/**
 * The #leaderboard channel: EVERY member, always current, edited in place.
 *
 * Not a feed. The old bot posted a line every time anyone moved, so one person
 * climbing twenty places produced twenty messages and everyone below was told
 * they had "fallen" for doing nothing. This is a scoreboard you glance at — the
 * rows simply move.
 *
 * Everyone is shown, deliberately. Martin's reason is the right one: you cannot
 * aim at somebody you cannot see, and picking a target two places above you is
 * most of what makes a leaderboard fun. So it is split into as many messages as
 * it takes, 25 to a message, each one edited rather than reposted.
 *
 * Message ids live in the kv table. If a message is deleted by hand the edit
 * fails, and we post a fresh one and remember that instead — so the board
 * repairs itself rather than going quiet forever.
 */
export async function publishLeaderboard(members, store) {
  const channel = env.DISCORD_LEADERBOARD_CHANNEL_ID;
  if (!channel) {
    console.log('No DISCORD_LEADERBOARD_CHANNEL_ID set — skipping the board.');
    return;
  }

  const chunks = chunkBoard(members);
  const known = (await store.get('board_message_ids', [])) || [];
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const ids = [];

  for (const [i, chunk] of chunks.entries()) {
    const first = i === 0;
    const heading = first
      ? `# Platinum Intel\n-# ${members.length} hunters · rarity points × completion · updated ${stamp} UTC`
      : `-# ranks ${chunk[0].rank}–${chunk[chunk.length - 1].rank}`;

    const body = message([
      text(heading),
      ...boardBlocks(chunk, { total: members.length }),
    ]);

    let id = known[i];
    if (id) {
      try {
        await rest(`/channels/${channel}/messages/${id}`, { method: 'PATCH', body });
      } catch (err) {
        console.log(`Board message ${id} could not be edited (${err.message}) — reposting.`);
        id = null;
      }
    }
    if (!id) {
      const posted = await rest(`/channels/${channel}/messages`, { body });
      id = posted.id;
    }
    ids.push(id);
  }

  // The board shrank — delete the leftovers rather than leaving stale ranks
  // sitting underneath the real ones.
  for (const stale of known.slice(chunks.length)) {
    try {
      await rest(`/channels/${channel}/messages/${stale}`, { method: 'DELETE' });
    } catch {
      /* already gone; nothing to do */
    }
  }

  await store.set('board_message_ids', ids);
  console.log(`Board published: ${members.length} hunters across ${ids.length} message(s).`);
}

// ------------------------------------------------------------- tier roles ---

/**
 * Give members the Discord role that matches where they are on the board.
 *
 * These roles were handed out by platinum count before Kraken existed, which is
 * why the counts look nothing like the leaderboard — 14 Golds and one Platinum
 * role held by nobody. From now on the role IS the rank: one Platinum, then the
 * top tenth Gold, the next third Silver, everyone else Bronze, exactly as
 * tierFor() computes it for the board.
 *
 * Three things worth knowing before touching this:
 *
 * 1. THE BOT'S ROLE MUST SIT ABOVE ALL FOUR in Server Settings -> Roles.
 *    Discord refuses to add or remove any role positioned above your own, and
 *    it refuses with a 403 that says nothing useful. If nobody's roles ever
 *    change, that is the first thing to check.
 *
 * 2. Roles are resolved BY NAME, not by id. Four ids in config would be four
 *    more things to paste and get wrong, and the names already have to match
 *    the board for the colours to mean anything.
 *
 * 3. Best-effort, always. A completed scan must never be reported as failed
 *    because Discord had a moment while handing out cosmetics.
 */
let roleCache = null;

/**
 * Role names are matched LOOSELY, on letters only.
 *
 * The first attempt compared the exact lowercased name and found nothing,
 * because the roles are called things like "🏆 Platinum" — a mod had put emoji
 * in front to make them stand out in the sidebar, which is an entirely
 * reasonable thing to do to a Discord server and none of the bot's business.
 *
 * So everything that is not a letter is stripped before comparing: emoji,
 * spaces, dashes, brackets, the lot. "🏆 Platinum", "[PLATINUM]" and
 * "· platinum ·" all resolve to the same role, and anybody can redecorate them
 * later without quietly breaking the leaderboard.
 *
 * An exact match wins over a prefix match, so a "Platinum Hunter" role can
 * never shadow the real "Platinum" one.
 */
const roleKey = (name) => String(name ?? '').replace(/[^a-z]/gi, '').toLowerCase();

async function tierRoleIds() {
  if (roleCache) return roleCache;
  const roles = await rest(`/guilds/${env.DISCORD_GUILD_ID}/roles`, { method: 'GET' });

  const find = (tier) =>
    (roles.find((r) => roleKey(r.name) === tier) ??
      roles.find((r) => roleKey(r.name).startsWith(tier)))?.id;

  roleCache = {
    platinum: find('platinum'),
    gold: find('gold'),
    silver: find('silver'),
    bronze: find('bronze'),
  };

  // Print what it actually matched, by the role's REAL name. Emoji in names is
  // exactly the sort of thing that silently resolves to the wrong role, so the
  // log should let you eyeball it rather than trust it.
  const found = Object.entries(roleCache).filter(([, id]) => id);
  if (found.length) {
    console.log(
      `  tier roles resolved: ${found
        .map(([tier, id]) => `${tier} → "${roles.find((r) => r.id === id).name}"`)
        .join(', ')}`,
    );
  }

  const missing = Object.entries(roleCache).filter(([, id]) => !id).map(([k]) => k);
  if (missing.length) {
    console.warn(`  no Discord role named: ${missing.join(', ')} — those members keep whatever they have`);
  }
  return roleCache;
}

/**
 * @param {Array<{discord_id:string, rank:number}>} ranked - everyone on the board
 * @param {Set<string>|null} only - limit to these discord ids (rank movers), or
 *   null for a full pass. Incremental is the normal case: a scan usually moves
 *   nobody, and a full pass costs one Discord call per member.
 */
export async function syncTierRoles(ranked, only = null) {
  // Say WHY, out loud. The first run of this did nothing at all and printed
  // nothing at all, which is the worst possible combination — there was no way
  // to tell "everyone already had the right role" from "this never ran".
  if (!env.DISCORD_GUILD_ID) {
    console.warn(
      '  tier roles: SKIPPED — DISCORD_GUILD_ID is not set for this job. ' +
        'Add it under Settings -> Secrets and variables -> Actions -> Variables.',
    );
    return { changed: 0, skipped: 0 };
  }
  if (!env.DISCORD_BOT_TOKEN) {
    console.warn('  tier roles: SKIPPED — DISCORD_BOT_TOKEN is not set for this job.');
    return { changed: 0, skipped: 0 };
  }

  let ids;
  try {
    ids = await tierRoleIds();
  } catch (err) {
    console.warn(`  tier roles: SKIPPED — could not read the server's roles: ${err.message}`);
    return { changed: 0, skipped: 0 };
  }

  const all = Object.values(ids).filter(Boolean);
  if (!all.length) {
    console.warn(
      '  tier roles: SKIPPED — no roles named Platinum, Gold, Silver or Bronze in this server.',
    );
    return { changed: 0, skipped: 0 };
  }

  const total = ranked.length;
  let changed = 0;
  let skipped = 0;

  for (const m of ranked) {
    if (only && !only.has(m.discord_id)) continue;

    const wanted = ids[tierFor(m.rank, total)];
    if (!wanted) continue;

    let current;
    try {
      // Per-member lookup rather than listing the whole guild: listing needs
      // the privileged GUILD_MEMBERS intent, which this bot does not ask for
      // and should not need just to colour a name.
      current = await rest(`/guilds/${env.DISCORD_GUILD_ID}/members/${m.discord_id}`, {
        method: 'GET',
      });
    } catch (err) {
      skipped += 1; // left the server, or Discord hiccuped
      continue;
    }

    const held = new Set(current.roles ?? []);
    const stale = all.filter((id) => id !== wanted && held.has(id));
    if (held.has(wanted) && !stale.length) continue;

    try {
      if (!held.has(wanted)) {
        await rest(`/guilds/${env.DISCORD_GUILD_ID}/members/${m.discord_id}/roles/${wanted}`, {
          method: 'PUT',
        });
      }
      // Removed AFTER the new one is added, so nobody is briefly tierless — and
      // so a failure halfway leaves them with too many roles rather than none.
      for (const id of stale) {
        await rest(`/guilds/${env.DISCORD_GUILD_ID}/members/${m.discord_id}/roles/${id}`, {
          method: 'DELETE',
        });
      }
      changed += 1;
    } catch (err) {
      skipped += 1;
      console.warn(`  could not set roles for ${m.discord_id}: ${err.message}`);
    }
  }

  // Always logged, even when it is zero. "0 updated" means everybody already
  // had the right role; silence means it never ran.
  console.log(
    `  tier roles: ${changed} updated, ${skipped} skipped, ` +
      `${only ? only.size : ranked.length} checked`,
  );
  if (skipped && !changed) {
    // Two different faults, two different fixes, and Discord's codes tell them
    // apart — so read the code rather than guessing. Getting this wrong cost a
    // round trip: the first version blamed role order for a 50001, which is the
    // other problem entirely.
    console.warn(
      '  every role change failed. Discord returns:\n' +
        '    50001 Missing Access      -> the bot lacks the MANAGE ROLES permission.\n' +
        '                                 Server Settings -> Roles -> the bot role ->\n' +
        '                                 Permissions -> turn on "Manage Roles".\n' +
        '    50013 Missing Permissions -> role ORDER. Drag the bot role ABOVE\n' +
        '                                 Platinum/Gold/Silver/Bronze.\n' +
        '  Both are required; having one is not enough.',
    );
  }
  return { changed, skipped };
}

// -------------------------------------------------------------- home page ---

/**
 * Kraken's home page — one message, edited in place forever.
 *
 * What a new member sees first. A short explanation of what the board is, live
 * numbers so it never reads like a dead README, and the FAQ behind a dropdown
 * so four walls of text stay one tidy line until somebody wants them.
 *
 * Published by the nightly rescore, so the counts are current without anyone
 * maintaining them. Self-healing in the same way as the leaderboard: if the
 * message is deleted, it posts a new one and remembers the new id.
 */
export async function publishHome(stats, store) {
  const channel = env.DISCORD_FAQ_CHANNEL_ID;
  if (!channel) return;

  const body = message([
    container(
      [
        section(
          [
            '# 🐙 Kraken',
            HOME_BLURB,
          ],
          thumbnail(
            env.DISCORD_HOME_IMAGE_URL ||
              'https://cdn.discordapp.com/embed/avatars/0.png',
            'Kraken',
          ),
        ),
        separator(),
        text(
          `-# **${n(stats.members)}** hunters · **${n(stats.games)}** games tracked · ` +
            `**${n(stats.trophies)}** trophies priced · **${n(stats.platinums)}** platinums between us`,
        ),
        separator(),
        text('### Questions\nPick a topic — the answer comes back just to you.'),
        selectMenu('faq', 'Choose a topic…', faqOptions()),
        ...(env.DISCORD_GUILD_ID && env.DISCORD_LEADERBOARD_CHANNEL_ID
          ? [row(
              linkButton(
                'Open the leaderboard',
                `https://discord.com/channels/${env.DISCORD_GUILD_ID}/${env.DISCORD_LEADERBOARD_CHANNEL_ID}`,
              ),
            )]
          : []),
      ],
      COLOR.blurple,
    ),
  ]);

  const known = await store.get('home_message_id', null);
  if (known) {
    try {
      await rest(`/channels/${channel}/messages/${known}`, { method: 'PATCH', body });
      return;
    } catch (err) {
      console.log(`Home message could not be edited (${err.message}) — reposting.`);
    }
  }
  const posted = await rest(`/channels/${channel}/messages`, { body });
  await store.set('home_message_id', posted.id);
}


// ------------------------------------------------- new projects / completed --

/**
 * Announce what somebody started and what they finished.
 *
 * The scan already knows: every changelog entry carries a `kind` of 'new',
 * 'completed' or 'progress', so this needs no extra PSN work — just the server
 * context that makes the card worth reading, which is one query.
 *
 * SKIPPED ON FIRST SCANS, and that is not a filter on what counts as news. A
 * first scan marks a member's ENTIRE LIBRARY as new, because none of it was in
 * member_games a minute ago. Pelziowo joining would post 15,411 games he
 * started years ago. Nothing about that is an announcement.
 *
 * Best-effort throughout. The scan is finished and saved by the time this runs;
 * a Discord outage must cost a message, never the update.
 */
/**
 * Which changelog entries belong in which channel.
 *
 * THE SUBTLE ONE IS `completed`. The scan tags a game `new` when it was not in
 * the library before and `completed` when it WAS and has just crossed 100% — so
 * a game that first appears already finished is only ever tagged `new`, and
 * fell through #completed entirely.
 *
 * Martin caught it in the first real card: Pelziowo's Arcade Archives 2 V'BALL
 * showed "2 own it · 2 finished" on a game he had only just started, because he
 * started and auto-platted it in the same session. It never reached #completed
 * and never would have.
 *
 * Shovelware is not what makes this worth fixing. Somebody who starts Bloodborne
 * on the Friday, plats it on the Sunday and runs /update afterwards is the same
 * case — and that is the post the whole channel exists for.
 *
 * A game can legitimately be BOTH. "Pelziowo started it" and "Pelziowo 100%'d
 * it" are each true and each happened, so it appears in both channels rather
 * than one picking a winner.
 */
export const PROJECT_FILTER = {
  new: (c) => c.kind === 'new',
  completed: (c) => c.kind === 'completed' || (c.kind === 'new' && c.progress_to === 100),
};

export async function postProjects(db, member, result, { first = false } = {}) {
  if (first || !result?.changelog?.length) return;

  const wanted = {
    new: env.DISCORD_NEW_PROJECTS_CHANNEL_ID,
    completed: env.DISCORD_COMPLETED_CHANNEL_ID,
  };

  for (const kind of ['new', 'completed']) {
    const channel = wanted[kind];
    if (!channel) continue; // variable unset — the feature is simply off

    const entries = result.changelog.filter(PROJECT_FILTER[kind]);
    if (!entries.length) continue;

    try {
      const games = await enrichGames(db, member, entries);
      const blocks = projectBlocks(member, kind, games);
      if (blocks) await rest(`/channels/${channel}/messages`, { body: message([blocks]) });
    } catch (err) {
      console.error(`Could not post ${kind} projects:`, err.message);
    }
  }
}

/**
 * The context that turns "Martin started Bloodborne" into something worth
 * reading: what it is worth, how many people here own it, how many have
 * finished it, where this member is in it, and whether it can be finished at
 * all.
 *
 * `completed_here` is counted rather than stored because it is the one figure
 * that changes on somebody else's scan and is cheap to ask for — unlike
 * local_started, which the settle job maintains because rarity depends on it.
 */
async function enrichGames(db, member, entries) {
  const ids = entries.map((e) => e.np_comm_id);

  // Paged at 80, because D1 rejects any statement with more than 100 bound
  // parameters and the account id spends one of them. A member coming back from
  // a fortnight away can easily bring thirty new games; nobody has hit a
  // hundred yet, and a card that silently fails to post is exactly the kind of
  // bug that goes unnoticed for a month.
  const byId = new Map();
  for (let i = 0; i < ids.length; i += 80) {
    const slice = ids.slice(i, i + 80);
    const rows = await db.query(
      `SELECT g.np_comm_id, g.title, g.platform, g.icon_url, g.trophy_count,
              g.max_points, g.local_started, g.estimated,
              g.unobtainable, g.unobtainable_note,
              mg.progress, mg.earned_total, mg.points AS member_points,
              mg.first_earned_at, mg.last_earned_at,
              (SELECT COUNT(*) FROM member_games x
                WHERE x.np_comm_id = g.np_comm_id AND x.progress = 100) AS completed_here
         FROM games g
         LEFT JOIN member_games mg
           ON mg.np_comm_id = g.np_comm_id AND mg.psn_account_id = ?
        WHERE g.np_comm_id IN (${slice.map(() => '?').join(',')})`,
      [member.psn_account_id, ...slice],
    );
    for (const r of rows) byId.set(r.np_comm_id, r);
  }
  return entries
    .map((e) => {
      const row = byId.get(e.np_comm_id);
      if (!row) return null;
      return { ...row, days_taken: daysBetween(row.first_earned_at, row.last_earned_at) };
    })
    .filter(Boolean)
    // Most valuable first, so anything trimmed for length is the least
    // interesting thing in the batch rather than whatever sorted last.
    .sort((a, b) => (b.max_points ?? 0) - (a.max_points ?? 0));
}

/**
 * How long a game took, from its first trophy to its last.
 *
 * NULL rather than zero when either stamp is missing — a row scanned before
 * migration 006 existed knows nothing about timing, and "took under a day" is a
 * much worse answer than saying nothing at all.
 */
function daysBetween(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return Math.floor((to - from) / 86400000);
}
