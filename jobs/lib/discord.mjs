/**
 * Discord REST posting from the scan job.
 *
 * The Worker replies to the interaction instantly with "queued", then this
 * edits that same message once the scan finishes — so the member sees one
 * message that fills itself in, rather than a wall of bot spam.
 */

import {
  configureEmoji,
  message,
  updateCard,
  movementLines,
  container,
  text,
  boardBlocks,
  chunkBoard,
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

/** Replace the "queued" placeholder with the finished update card. */
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

  let msg;
  if (interactionToken) {
    msg = await rest(
      `/webhooks/${env.DISCORD_APPLICATION_ID}/${interactionToken}/messages/@original`,
      { method: 'PATCH', body, useBotToken: false },
    );
  } else {
    msg = await rest(`/channels/${env.DISCORD_UPDATES_CHANNEL_ID}/messages`, { body });
  }

  if (result.changelog?.length && msg?.id) {
    await postChangelogThread(msg, member, result);
  }
  return msg;
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
      ? `# Platinum Intel\n-# ${members.length} hunters · ranked by rarity points · updated ${stamp} UTC`
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
