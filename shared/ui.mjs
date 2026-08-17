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
 * The Platinum Intel server's own trophy emoji.
 *
 * Hardcoded rather than configured. An emoji id is not a secret — it is
 * visible in the raw text of every message that uses one — and the two halves
 * of this system get their configuration through completely different
 * mechanisms, so making these settings would mean maintaining the same four
 * values in the Cloudflare dashboard AND the scan workflow, forever, for
 * something that changes approximately never.
 *
 * `configureEmoji` still honours EMOJI_* overrides, so a fork can swap them
 * without touching this file.
 */
let EMOJI = {
  platinum: '<:platinum:1539028113273397298>',
  gold: '<:gold:1539028372980768828>',
  silver: '<:silver:1539028431675727913>',
  bronze: '<:bronze:1539028492241608816>',
};

export function configureEmoji(source = {}) {
  EMOJI = {
    platinum: source.EMOJI_PLATINUM || EMOJI.platinum,
    gold: source.EMOJI_GOLD || EMOJI.gold,
    silver: source.EMOJI_SILVER || EMOJI.silver,
    bronze: source.EMOJI_BRONZE || EMOJI.bronze,
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

export const pct = (value) => `${Number(value ?? 0).toFixed(2)}%`;

export const ordinal = (v) => {
  const i = Number(v);
  const mod100 = i % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${i}th`;
  return `${i}${['th', 'st', 'nd', 'rd'][i % 10] || 'th'}`;
};

/** Movement since the member's last update. Empty when they haven't moved. */
export function trend(rank, prevRank) {
  if (!rank || !prevRank || rank === prevRank) return '';
  return rank < prevRank ? ` ▲${prevRank - rank}` : ` ▼${rank - prevRank}`;
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

/** One leaderboard entry — the card from the old bot, natively drawn. */
export function memberCard(m, { total = 0, highlight = false } = {}) {
  const tier = tierFor(m.rank, total);
  const { name: tierName, color } = TIERS[tier];

  const country = flag(m.country);
  const who = highlight ? `__${m.psn_online_id}__` : m.psn_online_id;
  const position = `${ordinal(m.rank)}${trend(m.rank, m.prev_rank)}`;

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
          `**Completion** ${pct(m.completion)}\n` +
            `**Points** ${n(m.points)}\n` +
            `-# ${tierEmoji(tier)} ${tierName} tier`,
        ],
        thumbnail(m.avatar_url || FALLBACK_AVATAR, m.psn_online_id),
      ),
      row(button('View profile', `profile:${m.discord_id}`)),
    ],
    color,
  );
}

/** The `/update` result — same shape as the old embed, plus the explanation. */
export function updateCard({ member, updateNo, before, after, delta, gamesChanged, durationSeconds }) {
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
