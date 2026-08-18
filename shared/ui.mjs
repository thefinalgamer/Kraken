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

export const IS_COMPONENTS_V2 = 1 << 15; // 32768

export const T = {
  ACTION_ROW: 1,
  BUTTON: 2,
  SECTION: 9,
  TEXT_DISPLAY: 10,
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
      const move =
        !m.prev_rank || m.prev_rank === m.rank
          ? ''
          : m.rank < m.prev_rank
            ? `${EMOJI.up}${m.prev_rank - m.rank} `
            : `${EMOJI.down}${m.rank - m.prev_rank} `;
      const who =
        m.discord_id && m.discord_id === viewerId
          ? `__${m.psn_online_id}__`
          : m.psn_online_id;
      return `\`${String(m.rank).padStart(3)}\` ${move}**${who}** — ${n(m.points)} pts · ${pct(m.completion)}`;
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

  // The fix: never show a bare negative number without saying why.
  if (delta.net < 0 && delta.drift < 0) {
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
      row(
        button('View changelog', `changelog:${updateNo}`),
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
