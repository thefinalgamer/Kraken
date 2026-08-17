/**
 * Registers the slash commands with Discord. Run once, and again whenever a
 * command's name, description or options change.
 *
 *   DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... \
 *     npm run register-commands
 *
 * Passing DISCORD_GUILD_ID registers them to your server only, which applies
 * instantly — right for the soft launch. Leave it out for a global rollout,
 * which Discord takes up to an hour to propagate.
 */

const env = process.env;

const commands = [
  {
    name: 'register',
    description: 'Link your PSN account and join the leaderboard',
    options: [
      {
        name: 'psn-id',
        description: 'Your PSN online ID, exactly as it appears on your profile',
        type: 3,
        required: true,
      },
    ],
  },
  {
    name: 'verify',
    description: 'Confirm the PSN account you registered is really yours',
  },
  {
    name: 'unlink',
    description: 'Mods only — free a member’s PSN link so it can be claimed again',
    // MANAGE_GUILD. Discord hides the command entirely from anyone without it,
    // so nobody has to discover it exists and then be told no.
    default_member_permissions: '32',
    options: [
      { name: 'member', description: 'The Discord member to unlink', type: 6, required: true },
    ],
  },
  {
    name: 'update',
    description: 'Rescan your trophies and update your card',
  },
  {
    name: 'rank',
    description: 'Your position on the board, and who you are chasing',
    options: [
      { name: 'member', description: 'Look up someone else instead', type: 6, required: false },
    ],
  },
  {
    name: 'leaderboard',
    description: 'The full board, ten at a time',
    options: [
      { name: 'page', description: 'Jump straight to a page', type: 4, required: false, min_value: 1 },
    ],
  },
  {
    name: 'game',
    description: 'What a game is worth to you, and who here has played it',
    options: [
      {
        name: 'title',
        description: 'Game title',
        type: 3,
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: 'backlog',
    description: 'Your unfinished games, ranked by what finishing them is worth',
    options: [
      {
        name: 'sort',
        description: 'How to order them',
        type: 3,
        required: false,
        choices: [
          { name: 'Most points', value: 'value' },
          { name: 'Nearly done', value: 'nearly' },
          { name: 'Quickest wins', value: 'quick' },
          { name: 'Rarest first', value: 'rare' },
        ],
      },
    ],
  },
];

const url = env.DISCORD_GUILD_ID
  ? `https://discord.com/api/v10/applications/${env.DISCORD_APPLICATION_ID}/guilds/${env.DISCORD_GUILD_ID}/commands`
  : `https://discord.com/api/v10/applications/${env.DISCORD_APPLICATION_ID}/commands`;

const res = await fetch(url, {
  method: 'PUT',
  headers: {
    Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(commands),
});

if (!res.ok) {
  console.error(`Failed (${res.status}):`, await res.text());
  process.exit(1);
}

console.log(
  `Registered ${commands.length} commands ` +
    (env.DISCORD_GUILD_ID ? `to guild ${env.DISCORD_GUILD_ID} (instant).` : 'globally (up to 1h).'),
);
