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

// Guild and global command sets are separate lists, and Discord shows BOTH —
// so a command registered globally once, then later registered to the guild,
// appears twice in the picker forever. Nobody can tell which is which, and at
// a hundred members that is a hundred people asking. Clearing the global list
// whenever we register to a guild keeps exactly one of each.
const api = (path, init = {}) =>
  fetch(`https://discord.com/api/v10/${path}`, {
    ...init,
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });

const clear = async (label, path) => {
  const res = await api(path, { method: 'PUT', body: '[]' });
  console.log(res.ok ? `Cleared ${label}.` : `Could not clear ${label} (${res.status}).`);
};

if (env.DISCORD_GUILD_ID) {
  // Registered to one guild, so the global list is the stale one.
  await clear('the global command list', `applications/${env.DISCORD_APPLICATION_ID}/commands`);
} else {
  // Registered globally, so any GUILD list left over from an earlier setup is
  // the stale one — and Discord shows the union, which is why everything
  // appears twice. The bot can enumerate its own servers, so this needs no
  // configuration: whatever it's in, it tidies.
  const res = await api('users/@me/guilds');
  if (!res.ok) {
    console.log(`Could not list the bot's servers (${res.status}) — skipping guild cleanup.`);
  } else {
    const guilds = await res.json();
    console.log(`Bot is in ${guilds.length} server(s); clearing any leftover guild commands.`);
    for (const g of guilds) {
      await clear(
        `guild commands in ${g.name}`,
        `applications/${env.DISCORD_APPLICATION_ID}/guilds/${g.id}/commands`,
      );
    }
  }
}

// ---------------------------------------------------------------- audit ----
//
// Duplicated commands in the picker are miserable to diagnose blind, because
// Discord shows the union of several lists and labels none of them. So print
// what actually exists afterwards, and say plainly what it means.

const listCommands = async (label, path) => {
  const res = await api(path);
  if (!res.ok) {
    console.log(`${label}: could not read (${res.status})`);
    return [];
  }
  const list = await res.json();
  console.log(
    `${label}: ${list.length}` +
      (list.length ? ` — ${list.map((c) => `/${c.name}`).join(' ')}` : ' (empty)'),
  );
  return list;
};

console.log('\n── what Discord actually has now ──');
const globals = await listCommands('Global', `applications/${env.DISCORD_APPLICATION_ID}/commands`);

let guildTotal = 0;
const gres = await api('users/@me/guilds');
if (gres.ok) {
  for (const g of await gres.json()) {
    const list = await listCommands(
      `Guild ${g.name}`,
      `applications/${env.DISCORD_APPLICATION_ID}/guilds/${g.id}/commands`,
    );
    guildTotal += list.length;
  }
}

if (globals.length && guildTotal) {
  console.log('\n⚠ Commands exist in BOTH the global and a guild list — that is the duplication.');
} else {
  console.log('\nOne list only — nothing here can produce a duplicate.');
  console.log(
    'If the picker still shows two of each after a Discord restart, check the developer\n' +
      'portal under Installation → Installation Contexts. With "User Install" enabled\n' +
      'alongside "Guild Install", commands appear once for the server and again for you\n' +
      'personally, and no amount of re-registering will change it.',
  );
}
