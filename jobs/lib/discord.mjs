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

/** The movement feed. Batched into one message per update, as the old bot did. */
export async function postMovements(movements) {
  if (!env.DISCORD_LEADERBOARD_CHANNEL_ID) return;
  const CHUNK = 15;
  for (let i = 0; i < movements.length; i += CHUNK) {
    await rest(`/channels/${env.DISCORD_LEADERBOARD_CHANNEL_ID}/messages`, {
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
