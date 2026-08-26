/**
 * Discord Components V2 builders.
 *
 * The old bot rendered its cards as flat images, which meant "View profile"
 * was a picture of a button rather than a button, text got truncated on narrow
 * screens (ALMIGHTYSHARKSTR's bronze count showed as "10,7…"), and none of it
 * scaled on mobile. Components V2 draws the same card natively — accent border,
 * avatar thumbnail, working buttons — so all three problems go away.
 *
 * Constraints worth remembering:
 *   - message flag 32768 (IS_COMPONENTS_V2) is required
 *   - `content` and `embeds` cannot be used at all once that flag is set
 *   - 40 top-level components per message, 10 per container
 *   - 4,000 characters total across every TextDisplay
 * Ten member cards per page sits comfortably inside all of these.
 */

import { nextCompletionStep } from './scoring.mjs';

export const IS_COMPONENTS_V2 = 1 << 15; // 32768

export const T = {
  ACTION_ROW: 1,
  BUTTON: 2,
  SECTION: 9,
  TEXT_DISPLAY: 10,
  STRING_SELECT: 3,
  THUMBNAIL: 11,
  MEDIA_GALLERY: 12,
  SEPARATOR: 14,
  CONTAINER: 17,
};

export const STYLE = { PRIMARY: 1, SECONDARY: 2, SUCCESS: 3, DANGER: 4, LINK: 5 };

export const COLOR = {
  orange: 0xe8871e,
  green: 0x23a55a,
  red: 0xf23f43,
  blurple: 0x5865f2,
  grey: 0x6f7378,
};

// ------------------------------------------------------------- primitives --

export const text = (content) => ({ type: T.TEXT_DISPLAY, content });

export const container = (components, accentColor) => ({
  type: T.CONTAINER,
  ...(accentColor != null ? { accent_color: accentColor } : {}),
  components,
});

export const section = (lines, accessory) => ({
  type: T.SECTION,
  components: (Array.isArray(lines) ? lines : [lines]).map(text),
  accessory,
});

export const thumbnail = (url, description) => ({
  type: T.THUMBNAIL,
  media: { url },
  ...(description ? { description } : {}),
});

export const separator = (large = false) => ({
  type: T.SEPARATOR,
  divider: true,
  spacing: large ? 2 : 1,
});

export const button = (label, customId, style = STYLE.SECONDARY, extra = {}) => ({
  type: T.BUTTON,
  style,
  label,
  custom_id: customId,
  ...extra,
});

export const linkButton = (label, url) => ({ type: T.BUTTON, style: STYLE.LINK, label, url });

export const row = (...components) => ({ type: T.ACTION_ROW, components });

/**
 * A dropdown. Must be the ONLY thing in its action row — Discord rejects a row
 * holding a select menu alongside anything else, including another select.
 *
 * @param {string} customId
 * @param {string} placeholder - shown before anything is chosen
 * @param {Array<{label:string, value:string, description?:string, emoji?:object}>} options
 */
export const selectMenu = (customId, placeholder, options) =>
  row({
    type: T.STRING_SELECT,
    custom_id: customId,
    placeholder,
    options: options.map((o) => ({
      label: o.label.slice(0, 100),
      value: o.value,
      ...(o.description ? { description: o.description.slice(0, 100) } : {}),
      ...(o.emoji ? { emoji: o.emoji } : {}),
    })),
  });

/** Wrap components into a sendable message body. */
export const message = (components, { ephemeral = false } = {}) => ({
  flags: IS_COMPONENTS_V2 | (ephemeral ? 64 : 0),
  components,
});

// --------------------------------------------------------------- helpers ---

/**
 * Trophy icons.
 *
 * Resolved at runtime rather than read from `process.env` at import time,
 * because that global doesn't exist in a Cloudflare Worker — the Worker gets
 * its config through the `env` binding instead. Both halves call
 * configureEmoji() at startup; until they do, the unicode fallbacks keep
 * everything readable.
 *
 * Set these to the custom emoji you upload to the server, in Discord's
 * `<:name:id>` form.
 */
const UNICODE_FALLBACK = {
  platinum: '🏆',
  gold: '🥇',
  silver: '🥈',
  bronze: '🥉',
};

/**
 * Kraken's trophy icons — APP-owned emoji, not server emoji.
 *
 * This distinction matters and cost an evening to find. Every card here is
 * sent as an interaction response, which Discord treats as a webhook message,
 * and webhook messages need USE_EXTERNAL_EMOJIS to render a custom emoji —
 * even one from the very server they are posted in. Without it Discord does
 * not error; it silently renders `:platinum:` as plain text and leaves you
 * staring at correct-looking code.
 *
 * Emoji owned by the application have no such requirement ("the
 * USE_EXTERNAL_EMOJIS permission is not required to use app emojis"), work in
 * every server the bot is ever added to, and cannot be broken by someone
 * reorganising role permissions. Manage them at:
 *
 *   discord.com/developers/applications -> Kraken -> Emojis
 *
 * Hardcoded rather than configured, because an emoji id is not a secret — it
 * is visible in the raw text of every message using it — and the Worker and
 * the scan job take their configuration through completely different
 * mechanisms, so making these settings would mean maintaining the same four
 * values in two places forever, for something that changes approximately
 * never. `configureEmoji` still honours EMOJI_* overrides for forks.
 */
let EMOJI = {
  platinum: '<:platinum:1539032665217310730>',
  gold: '<:gold:1539032682514612274>',
  silver: '<:silver:1539032715943481484>',
  bronze: '<:bronze:1539032726701735955>',
  // Discord offers no way to colour text, so a green ▲ and a red ▼ have to be
  // emoji — and unicode has no green/red arrow pair, only red ones.
  up: '<:up:1539040642007695401>',
  down: '<:down:1539040656847278211>',
};

export function configureEmoji(source = {}) {
  // Spread the existing set rather than rebuilding it. Listing the keys
  // explicitly meant every emoji NOT named here — the trend arrows — was
  // silently dropped the moment this ran, and rendered as "undefined".
  EMOJI = {
    ...EMOJI,
    platinum: source.EMOJI_PLATINUM || EMOJI.platinum,
    gold: source.EMOJI_GOLD || EMOJI.gold,
    silver: source.EMOJI_SILVER || EMOJI.silver,
    bronze: source.EMOJI_BRONZE || EMOJI.bronze,
    up: source.EMOJI_UP || EMOJI.up,
    down: source.EMOJI_DOWN || EMOJI.down,
  };
}

/** Escape hatch: if the custom emoji are ever deleted, this restores readability. */
export const useUnicodeTrophies = () => {
  EMOJI = { ...UNICODE_FALLBACK };
};

export const emoji = () => EMOJI;

export const UP = '🟩';
export const DOWN = '🟥';

// ------------------------------------------------------------------ tiers --

/**
 * Ranking tiers. Percentage-based so they stay meaningful whether the server
 * has five members or five hundred, with floors so they don't collapse while
 * the board is still tiny.
 *
 * The trade-off worth remembering: a member can drop a tier because other
 * people joined, not because they did anything wrong. Swap to fixed point
 * thresholds here if that turns out to grate.
 */
export const TIERS = {
  platinum: { name: 'Platinum', color: 0x5fc0f0 },
  gold: { name: 'Gold', color: 0xf0c419 },
  silver: { name: 'Silver', color: 0xb9bbbe },
  bronze: { name: 'Bronze', color: 0xe07b39 },
};

export const TIER_SHARES = { gold: 0.1, silver: 0.33 };

export function tierFor(rank, total) {
  if (!rank || !total) return 'bronze';
  if (rank === 1) return 'platinum';
  const goldMax = Math.max(3, Math.ceil(total * TIER_SHARES.gold));
  const silverMax = Math.max(10, Math.ceil(total * TIER_SHARES.silver));
  if (rank <= goldMax) return 'gold';
  if (rank <= silverMax) return 'silver';
  return 'bronze';
}

export const tierEmoji = (tier) => EMOJI[tier] ?? EMOJI.bronze;

// ---------------------------------------------------------------- display --

export const n = (value) => Number(value ?? 0).toLocaleString('en-GB');

export const signed = (value, suffix = '') => {
  const v = Number(value ?? 0);
  if (v === 0) return `0${suffix}`;
  return `${v > 0 ? '+' : '−'}${n(Math.abs(v))}${suffix}`;
};

/**
 * Percentages are FLOORED, never rounded to nearest.
 *
 * toFixed rounds up, so 74.996% would print as 75.00% — a member reading a
 * milestone they have not reached, and later a badge that disagrees with their
 * own card. Always erring a hundredth low is the harmless direction: nobody
 * has ever complained about being under-credited by 0.01%.
 */
export const pct = (value) => `${(Math.floor(Number(value ?? 0) * 100) / 100).toFixed(2)}%`;

/**
 * "-> 92% pays next", or nothing at all when there is nothing to reach.
 *
 * Completion pays in whole percentage points, so 91.42% and 91.98% bank exactly
 * the same score. Without this line that reads as the bot ignoring your
 * progress; with it, the gap between the two numbers is a target. See
 * COMPLETION_STEP in scoring.mjs for why the step exists.
 */
export const nextPayout = (completion) => {
  const c = Number(completion ?? 0);
  const next = nextCompletionStep(c);
  if (next == null) return '';
  // Already exactly on a step: the number they can see IS what they are paid,
  // and pointing at the next one would just nag.
  if (Math.abs(c - Math.floor(c)) < 0.005) return '';
  // Its own line. Discord only renders "-#" as small text at the START of a
  // line — inline it prints the two characters literally.
  return `\n-# ${next}% is the next payout`;
};

export const ordinal = (v) => {
  const i = Number(v);
  const mod100 = i % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${i}th`;
  return `${i}${['th', 'st', 'nd', 'rd'][i % 10] || 'th'}`;
};

/** Movement since the member's last update. Empty when they haven't moved. */
export function trend(rank, prevRank) {
  if (!rank || !prevRank || rank === prevRank) return '';
  return rank < prevRank
    ? ` ${EMOJI.up}${prevRank - rank}`
    : ` ${EMOJI.down}${rank - prevRank}`;
}

/**
 * "4,812 behind RabbitSquared" — the single most useful line on a card.
 *
 * A position tells someone where they are. A gap tells them what to do about
 * it. At a hundred members almost nobody is chasing first place, but everybody
 * has one person just above them, and that is the one they will actually go
 * after.
 */
export function chaseLine(member, above) {
  if (!above) return '';
  const gap = Number(above.points ?? 0) - Number(member.points ?? 0);
  if (gap <= 0) return '';
  return `${EMOJI.up} **${n(gap)}** behind ${above.psn_online_id}`;
}

/**
 * How long ago a member's data was refreshed.
 *
 * With a hundred members half the board is stale at any moment. Saying so
 * quietly is more honest than presenting month-old figures as current, and it
 * nudges people to run /update without anyone having to nag them.
 */
export function lastSeen(timestamp, now = Date.now()) {
  if (!timestamp) return '';
  const mins = Math.floor((now - Number(timestamp)) / 60000);
  if (mins < 2) return 'updated just now';
  if (mins < 60) return `updated ${mins} minutes ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `updated ${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `updated ${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  return `updated ${months} month${months === 1 ? '' : 's'} ago`;
}

/**
 * A member's rarest owned trophy. NOT currently shown anywhere — deliberately.
 *
 * The card was getting cluttered, and the line reads poorly today because the
 * one-call-per-game scan doesn't return trophy NAMES, only rarity, so it can
 * name the game and nothing more.
 *
 * The scan still records rarest_name / rarest_rate / rarest_game on every
 * update, which costs one query and keeps the door open: if this ever becomes
 * a feature — a profile view, a weekly digest, a "rarest on the server" board —
 * the data is already there with months of history behind it instead of
 * starting from zero.
 */
export function rarestLine(m) {
  if (!m.rarest_name || !(Number(m.rarest_rate) > 0)) return '';
  return `◆ ${m.rarest_name} · ${Number(m.rarest_rate).toFixed(2)}%`;
}

/**
 * Regional indicator flag from a two-letter country code. 'GB' becomes 🇬🇧 by
 * shifting each letter into the Unicode regional-indicator block.
 */
export function flag(countryCode) {
  const cc = String(countryCode ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return '';
  return String.fromCodePoint(
    ...[...cc].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65),
  );
}

export const trophyLine = (m) =>
  `${EMOJI.platinum} **${n(m.platinum)}**  ${EMOJI.gold} **${n(m.gold)}**  ` +
  `${EMOJI.silver} **${n(m.silver)}**  ${EMOJI.bronze} **${n(m.bronze)}**`;

/**
 * One leaderboard entry — the card from the old bot, natively drawn.
 *
 * @param {object} opts.above    the member one rank higher, for the chase line
 * @param {boolean} opts.showTier  print the tier name. Off on the leaderboard,
 *   where the accent colour already says it and the label is pure noise; on
 *   for /rank, which has room and where somebody might genuinely be checking.
 */
export function memberCard(m, { total = 0, highlight = false, above = null, showTier = false } = {}) {
  const tier = tierFor(m.rank, total);
  const { name: tierName, color } = TIERS[tier];

  const country = flag(m.country);
  const who = highlight ? `__${m.psn_online_id}__` : m.psn_online_id;
  const position = `${ordinal(m.rank)}${trend(m.rank, m.prev_rank)}`;

  // Folded into the third block on purpose — see the note below.
  const footer = [
    chaseLine(m, above),
    lastSeen(m.last_update_at),
    showTier ? `${tierEmoji(tier)} ${tierName} tier` : '',
  ]
    .filter(Boolean)
    .map((line) => `-# ${line}`)
    .join('\n');

  return container(
    [
      // EXACTLY THREE text blocks. A Section accepts 1-3 components and Discord
      // rejects the entire message if you send a fourth — which surfaces to the
      // member as "Kraken didn't respond in time", with no clue as to why.
      // Anything extra has to be folded into one of these three, not appended.
      section(
        [
          `### ${position} · ${country ? `${country} ` : ''}${who}`,
          trophyLine(m),
          `**Completion** ${pct(m.completion)}\n**Points** ${n(m.points)}` +
            nextPayout(m.completion) +
            (footer ? `\n${footer}` : ''),
        ],
        thumbnail(m.avatar_url || FALLBACK_AVATAR, m.psn_online_id),
      ),
      row(button('View profile', `profile:${m.discord_id}`)),
    ],
    color,
  );
}

/**
 * The leaderboard as a MONOSPACE TABLE rather than a stack of cards.
 *
 * Not a style choice — a hard constraint. Discord allows 40 components in a
 * message and counts nested ones, and a member card is 8 (container, section,
 * three text blocks, thumbnail, button row, button). So five cards is 45 and
 * Discord rejects the entire message, which reaches the member as the
 * spectacularly unhelpful "Kraken didn't respond in time".
 *
 * This board broke the day a fifth member registered. A table is ONE component
 * however many people are on it, so it cannot break this way at any size.
 *
 * Cards are still right for /rank — three of them is 29 components, and when
 * you are looking at yourself and the two people either side you want the
 * avatars and the detail.
 *
 * Rendered inside a code block so the columns line up on every device. That
 * also means no custom emoji and no bold — code blocks render neither — hence
 * plain ▲▼ for movement and a » marker for "this is you".
 */
export function boardBlocks(
  members,
  { viewerId = null, total = 0, startRank = 1 } = {},
) {
  const size = total || members.length;
  const groups = [];
  for (const [i, m] of members.entries()) {
    const rank = m.rank ?? startRank + i;
    const tier = tierFor(rank, size);
    if (!groups.length || groups[groups.length - 1].tier !== tier) {
      groups.push({ tier, rows: [] });
    }
    groups[groups.length - 1].rows.push({ ...m, rank });
  }

  return groups.map(({ tier, rows }) => {
    const { name, color } = TIERS[tier];
    const lines = rows.map((m) => {
      // The count is separated from the name and glued to the arrow. Without
      // the gap `▼1 N7_Maxxi` reads as though the 1 belongs to the name.
      const move =
        !m.prev_rank || m.prev_rank === m.rank
          ? ''
          : m.rank < m.prev_rank
            ? `${EMOJI.up}\`${m.prev_rank - m.rank}\` `
            : `${EMOJI.down}\`${m.rank - m.prev_rank}\` `;
      const who =
        m.discord_id && m.discord_id === viewerId
          ? `__${m.psn_online_id}__`
          : m.psn_online_id;
      return `\`${String(m.rank).padStart(3)}\` ${move}**${who}** - ${n(m.points)} pts · ${pct(m.completion)}`;
    });
    return container(
      [text(`${tierEmoji(tier)} **${name}**`), text(lines.join('\n'))],
      color,
    );
  });
}

/**
 * How many members go in one Discord message.
 *
 * Bounded by two ceilings: 40 components per message, and 4,000 characters
 * across every text block. The component side is generous here — a tier is
 * three components however many people are in it — so characters bind first,
 * and a rich row runs about 80 once the custom emoji ids are counted (an emoji
 * is thirty characters of markup for one small picture).
 */
export const BOARD_CHUNK = 25;

/** Split members into message-sized chunks, preserving rank order. */
export function chunkBoard(members, size = BOARD_CHUNK) {
  const out = [];
  for (let i = 0; i < members.length; i += size) out.push(members.slice(i, i + size));
  return out;
}

/** Characters a set of blocks will cost, for checking against the 4,000 limit. */
export function blockChars(blocks) {
  let chars = 0;
  const walk = (x) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (x && typeof x === 'object') {
      if (x.type === T.TEXT_DISPLAY && x.content) chars += x.content.length;
      Object.values(x).forEach(walk);
    }
  };
  walk(blocks);
  return chars;
}



/** The `/update` result — same shape as the old embed, plus the explanation. */
export function updateCard({
  member, updateNo, before, after, delta, gamesChanged, durationSeconds, repaired = 0,
}) {
  const gained = [
    after.platinum - before.platinum && `${EMOJI.platinum} ${signed(after.platinum - before.platinum)}`,
    after.gold - before.gold && `${EMOJI.gold} ${signed(after.gold - before.gold)}`,
    after.silver - before.silver && `${EMOJI.silver} ${signed(after.silver - before.silver)}`,
    after.bronze - before.bronze && `${EMOJI.bronze} ${signed(after.bronze - before.bronze)}`,
  ].filter(Boolean);

  const lines = [`## Update No. ${updateNo}`];
  if (gained.length) lines.push(gained.join('   '));
  lines.push(
    [
      `**New projects:** ${signed(after.projects - before.projects)}`,
      `**Completed:** ${signed(after.completed - before.completed)}`,
      `**Completion:** ${signed(after.completion - before.completion, '%')}`,
      `**Points:** ${signed(delta.net)}`,
    ].join('\n'),
  );

  // The backlog payout gets its own callout, and it is the most important line
  // on this card. These points arrive attached to games the member did not
  // touch this session — their whole library re-priced because their completion
  // moved — so without a name for it the number reads as the bot making things
  // up. Named, it is the exact moment the system teaches itself: finish old
  // games, get paid on everything.
  const backlog = delta.backlog ?? 0;
  if (backlog > 0) {
    lines.push(
      `> ### ${EMOJI.up} Backlog payout: ${signed(backlog)}\n` +
        `> Your completion went ${pct(before.completion)} → ${pct(after.completion)}, ` +
        `so **every game you own** just re-priced. Most of this is points for ` +
        `old games you didn't touch today.`,
    );
  } else if (backlog < 0) {
    // Starting new games costs you. Say so plainly — it is a design decision,
    // not a malfunction, and the member is owed the reason.
    lines.push(
      `> **Completion dipped ${pct(before.completion)} → ${pct(after.completion)}** ` +
        `(${signed(backlog)}). Starting a game adds trophies you haven't earned yet, ` +
        `so your share of everything drops a little. Finish it and you get this back ` +
        `with interest.`,
    );
  }

  // NOTHING EARNED, BUT THE NUMBER MOVED. This is the whole of layer two seen
  // from the receiving end: somebody else picked up a game you own and yours
  // got more valuable, or somebody finished one and it settled back down. It
  // needs its own branch because both of the cases below assume the member
  // earned something this session, and the entire point of local rarity is
  // that your score moves when you weren't playing at all.
  //
  // No threshold. Martin's call, and it is the right one — a board that only
  // speaks up above some floor teaches people the small moves aren't real, and
  // small moves compounding is exactly what an economy is. If it was three
  // points, it says three points.
  if (delta.drift && !delta.earned) {
    // TWO VERY DIFFERENT PEOPLE END UP HERE, and the first version of this told
    // them both the same thing.
    //
    // JFL__Leon earned a bronze on Sea of Thieves, gained 1,587 points, and was
    // told "you earned nothing this session". He had earned something — it just
    // scored zero, because more than half of PlayStation has that trophy. Every
    // word of the card was arithmetically true and the sentence was a lie about
    // his evening.
    //
    // So: check whether any trophy actually landed, and if one did, say why it
    // paid nothing rather than pretending it did not happen.
    const earnedTrophies =
      after.platinum - before.platinum +
      (after.gold - before.gold) +
      (after.silver - before.silver) +
      (after.bronze - before.bronze);
    const those = earnedTrophies === 1 ? 'The trophy you earned is' : `Your ${n(earnedTrophies)} trophies are`;
    const zeroPaid =
      `${those} common enough to score nothing. More than half of PlayStation ` +
      `already ${earnedTrophies === 1 ? 'has it' : 'has them'}, so ${earnedTrophies === 1 ? 'it pays' : 'they pay'} zero. `;

    lines.push(
      delta.drift > 0
        ? `> ### ${EMOJI.up} Rarity drift: ${signed(delta.drift)}\n> ` +
            (earnedTrophies > 0
              ? `${zeroPaid}Every one of these points came from the server instead: other ` +
                'members picked up games you own, and a game is worth more while people ' +
                'are still stuck on it.'
              : 'You earned nothing this session and gained anyway. Other members ' +
                'picked up games you own, and a game is worth more while people are ' +
                'still stuck on it.')
        : `> **Rarity drift: ${signed(delta.drift)}**\n> ` +
            (earnedTrophies > 0
              ? `${zeroPaid}The move is other members finishing games you own. Trophies ` +
                'settle back towards their normal value once everybody who owns them has ' +
                'done them. Nothing was taken away.'
              : "You earned nothing this session and the number still moved. That's " +
                'other members finishing games you own. Trophies settle back towards ' +
                'their normal value once everybody who owns them has done them. ' +
                'Nothing was taken away.'),
    );
  } else if (delta.net < 0 && delta.drift < 0 && backlog >= 0) {
    lines.push(
      `> **Why the drop?** You earned ${signed(delta.earned)} points from new trophies, ` +
        `but trophies you already had have become more common as other players caught up ` +
        `(${signed(delta.drift)}). Nothing was taken away.`,
    );
  } else if (delta.earned && delta.drift) {
    // Even on a good update, showing the split teaches people what the number
    // means while they're pleased with it — which is a far better time to
    // learn it than the first time it goes backwards.
    lines.push(
      `-# ${signed(delta.earned)} from new trophies, ${signed(delta.drift)} from rarity shifting.`,
    );
  }

  // A repaired game is one that had been silently scoring ZERO — progress
  // recorded, rarity never written, usually because an earlier scan died
  // partway. When the fix lands, points can jump by tens of thousands with no
  // trophies earned, and an unexplained jump like that reads as the bot
  // inventing numbers. Say it plainly instead.
  if (repaired > 0) {
    lines.push(
      `> **${n(repaired)} game${repaired === 1 ? '' : 's'} repaired.** ` +
        `${repaired === 1 ? 'It was' : 'They were'} missing rarity data from an interrupted scan ` +
        `and had been scoring nothing. ${repaired === 1 ? 'It is' : 'They are'} counted now, ` +
        `so part of this change is points you already had but weren't being given.`,
    );
  }

  lines.push(
    `-# Update took ${formatDuration(durationSeconds)} · ${n(gamesChanged)} game${gamesChanged === 1 ? '' : 's'} changed`,
  );

  return container(
    [
      text(lines.join('\n\n')),
      // Only offer the changelog when there IS one. A button that opens an
      // apology is worse than no button.
      row(
        ...(gamesChanged > 0 ? [button('View changelog', `changelog:${updateNo}`)] : []),
        button('My rank', `rank:${member.discord_id}`),
      ),
    ],
    delta.net >= 0 ? COLOR.green : COLOR.red,
  );
}

/** `#leaderboard` movement feed. Kept deliberately brutal — that's the fun. */
export function movementLines(movements) {
  return movements
    .map((m) =>
      m.direction === 'up'
        ? `${UP} **${m.onlineId}** moved to **${ordinal(m.to)}** position!`
        : `${DOWN} **${m.onlineId}** fell to **${ordinal(m.to)}** position!`,
    )
    .join('\n');
}

function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return 'a moment';
  if (seconds < 90) return `${seconds} seconds`;
  return `${Math.round(seconds / 60)} minutes`;
}

export const FALLBACK_AVATAR = 'https://cdn.discordapp.com/embed/avatars/0.png';

// -------------------------------------------------------------- digest -----

/**
 * The week, in one card.
 *
 * Most of a sixty-person server never runs a command in a given week. Every
 * other thing Kraken posts is triggered by somebody doing something; this is
 * the one that reaches the people who did not. That is the whole argument for
 * it, and it is why it goes in #updates rather than #leaderboard — the board
 * rewrites itself in place and a digest underneath it would be lost.
 *
 * Lines are DROPPED rather than shown empty. A quiet week with "Biggest
 * climber: nobody" reads as a broken bot; the same week with three lines reads
 * as a quiet week. Only the header is unconditional.
 *
 * "Crossed a point" was cut on Martin's call — with sixty-odd members it would
 * have been half the card and nobody would read the rest.
 */
export function digestBlocks(d) {
  const lines = [];
  const add = (label, value) => value && lines.push(`**${label}** ${value}`);

  if (d.climber) {
    add(
      'Biggest climber',
      `**${d.climber.onlineId}** - ${ordinal(d.climber.from)} → ${ordinal(d.climber.to)}` +
        (d.climber.points ? `, ${signed(d.climber.points)}` : ''),
    );
  }
  if (d.faller) {
    add('Biggest fall', `**${d.faller.onlineId}** - ${ordinal(d.faller.from)} → ${ordinal(d.faller.to)}`);
  }
  if (d.rarestPlat) {
    add(
      'Rarest platinum',
      `**${d.rarestPlat.title}** at ${pct(d.rarestPlat.rate)} - ${d.rarestPlat.onlineId}`,
    );
  }
  if (d.toughest) {
    add(
      'Biggest finish',
      `**${d.toughest.title}** - ${n(d.toughest.points)} points, ${d.toughest.onlineId}`,
    );
  }
  if (d.contested) {
    add(
      'Most contested',
      `**${d.contested.title}** - ${n(d.contested.stuck)} of us still in it`,
    );
  }
  if (d.completed > 0) {
    add('Finished', `**${n(d.completed)}** game${d.completed === 1 ? '' : 's'} taken to 100%`);
  }
  if (d.points > 0) {
    add('Earned', `**${signed(d.points)}** points between ${n(d.members)} of us`);
  }
  if (d.joined > 0) {
    add('New faces', `**${n(d.joined)}** joined this week`);
  }

  return container(
    [
      text(`## 📅 The week on Platinum Intel\n-# ${d.range}`),
      separator(),
      text(
        lines.length
          ? lines.join('\n')
          : 'Nobody scanned anything. The board is exactly where you left it.',
      ),
      separator(),
      text('-# Posted every Monday, once the refresh has been round everybody.'),
    ],
    COLOR.blurple,
  );
}

// ----------------------------------------------------------- contested -----

/**
 * The games the server is collectively stuck on, and what they are paying.
 *
 * This exists because layer two was a rule people were TOLD about rather than
 * anything they could look at. The multiplier moved, the points moved, and the
 * only evidence was a line on an update card after the fact. A standing board
 * turns the best mechanic in the system into somewhere to go.
 *
 * The multiplier shown is the PLATINUM's, and that is the honest choice rather
 * than the convenient one. Local rarity is per trophy, so a game has no single
 * multiplier — but "we are all stuck on this" means the plat, and the plat's
 * figure is a real number the scoring uses rather than an average invented for
 * display. Games with no platinum are left off: there is nothing to be stuck on.
 *
 * @param {Array} rows - {title, local_started, platted_here, multiplier, unobtainable}
 */
export function contestedBlocks(rows, { standing = true } = {}) {
  if (!rows?.length) {
    return container(
      [
        text(
          '## 🔥 Contested right now\n\nNothing is contested. Every game somebody here owns, ' +
            'somebody here has already platted.\n\n-# Start something hard and this fills up.',
        ),
      ],
      COLOR.grey,
    );
  }

  const lines = rows.map((g, i) => {
    const stuck = Math.max(0, Number(g.local_started ?? 0) - Number(g.platted_here ?? 0));
    return (
      `\`${String(i + 1).padStart(2)}\` **${g.title}**${g.unobtainable ? ' ⚠️' : ''} - ` +
      `**×${Number(g.multiplier ?? 1).toFixed(2)}**\n` +
      `-# ${n(g.local_started)} own it · ${n(g.platted_here)} platted · ` +
      `**${n(stuck)}** still in it`
    );
  });

  return container(
    [
      text(
        '## 🔥 Contested right now\n' +
          '-# Games we are still stuck on. Every trophy in them pays more until the last of ' +
          'us finishes.',
      ),
      separator(),
      text(lines.join('\n')),
      separator(),
      text(
        '-# Pick one up and it gets **cheaper for everyone else** the moment you finish it. ' +
          (standing
            ? 'Rewritten after every update.'
            : 'Run `/game` on any of them for the full breakdown.'),
      ),
    ],
    COLOR.orange,
  );
}

// ------------------------------------------------- new projects / completed --

/**
 * The card that goes in #new-projects and #completed.
 *
 * Martin: "when some one starts a new project announce it there with a little
 * card about the game maybe? saying how many trophies how many people have done
 * the game, started the game, completed it, how many points its worth, and if
 * you have already started it your info."
 *
 * ONE MESSAGE PER UPDATE, not one per game, and that is the whole design.
 * Martin asked for every new game to be announced — no shovelware filter, no
 * size threshold — which is the right call for a channel whose job is to show
 * what the server is playing. But somebody syncing a weekend of play can bring
 * back thirty new games at once, and thirty separate posts is not a feed, it is
 * a flood that buries the one interesting game in it.
 *
 * So: one game gets the full card, thumbnail and all, because a single new
 * project IS the event. Several get a header and a line each, ordered by what
 * they are worth so any truncation drops the shovelware rather than the
 * Bloodborne. Every game is still named either way.
 *
 * @param {object}  member
 * @param {'new'|'completed'} kind
 * @param {Array}   games - enriched rows, most valuable first
 */
export function projectBlocks(member, kind, games) {
  if (!games?.length) return null;
  const started = kind === 'new';
  const verb = started ? 'started' : "100%'d";
  const icon = started ? '🆕' : '✅';
  const color = started ? COLOR.blurple : COLOR.green;

  if (games.length === 1) {
    const g = games[0];
    return container(
      [
        section(
          [
            `## ${icon} ${member.psn_online_id} ${verb} ${g.title}`,
            `-# ${g.platform || 'PlayStation'} · ${n(g.trophy_count)} trophies` +
              (g.estimated ? ' · rarity not published by PSN, values are estimates' : ''),
            projectStats(g, started),
          ],
          thumbnail(g.icon_url || FALLBACK_AVATAR, g.title),
        ),
        ...(g.unobtainable
          ? [text(
              `> ### ⚠️ Some trophies here cannot be earned\n> ${
                g.unobtainable_note || 'Flagged by a mod. Ask in chat for the detail.'
              }`,
            )]
          : []),
        row(button('Full breakdown', `gamecard:${g.np_comm_id}`)),
      ],
      color,
    );
  }

  // Several at once. Built up to the character limit and stopped, same as the
  // changelog — a card Discord rejects for length shows nobody anything.
  const kept = [];
  let used = 0;
  for (const g of games) {
    const line =
      `${icon} **${g.title}**${g.unobtainable ? ' ⚠️' : ''} - ` +
      (started
        ? `${n(g.trophy_count)} trophies · **${n(g.max_points)}** points at 100% · ${localLine(g)}`
        : `**+${n(g.member_points)}** points banked · ${finisherLine(g)}`);
    if (used + line.length + 2 > 3200) break;
    kept.push(line);
    used += line.length + 2;
  }
  const hidden = games.length - kept.length;

  return container(
    [
      text(
        `## ${member.psn_online_id} ${verb} ${n(games.length)} game${games.length === 1 ? '' : 's'}\n\n` +
          kept.join('\n') +
          (hidden > 0 ? `\n-# …and ${n(hidden)} more.` : ''),
      ),
    ],
    color,
  );
}

/** The stats block on a single-game card. */
function projectStats(g, started) {
  const lines = [];
  if (started) {
    lines.push(`**Worth** ${n(g.max_points)} points at 100%`);
    lines.push(`**Your progress** ${g.progress ?? 0}% · ${n(g.earned_total ?? 0)} trophies`);
  } else {
    lines.push(`**Banked** ${n(g.member_points)} of ${n(g.max_points)} points`);
    if (g.days_taken != null) {
      lines.push(`**Took** ${g.days_taken === 0 ? 'under a day' : `${n(g.days_taken)} days`}`);
    }
  }
  lines.push(`**Here** ${localLine(g)}`);
  return lines.join('\n');
}

/**
 * "6 own it · 2 have 100%'d it". The reason the channel is worth reading: it is
 * how you find out somebody else is stuck on the same thing you are.
 */
function localLine(g) {
  const owners = Number(g.local_started ?? 0);
  const done = Number(g.completed_here ?? 0);
  if (owners <= 1) return 'nobody else here owns it yet';
  return `${n(owners)} own it · ${done === 0 ? 'nobody has finished it' : `${n(done)} finished`}`;
}

/** Where this finish sits in the server's history of the game. */
function finisherLine(g) {
  const done = Number(g.completed_here ?? 0);
  if (done <= 1) return 'first here to finish it';
  return `${ordinal(done)} here to finish it`;
}
