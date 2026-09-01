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
    description: 'Mods only. Free a member’s PSN link so it can be claimed again',
    // MANAGE_GUILD. Discord hides the command entirely from anyone without it,
    // so nobody has to discover it exists and then be told no.
    default_member_permissions: '32',
    options: [
      { name: 'member', description: 'The Discord member to unlink', type: 6, required: true },
    ],
  },
  {
    name: 'addmember',
    description: 'Mods only. Put someone on the board yourself, skipping verification',
    // MANAGE_GUILD, same as /unlink. This bypasses the PSN ownership check, so
    // it is the one command where a mod is vouching with their own judgement
    // instead of the member proving anything. Recorded as 'grandfathered'.
    default_member_permissions: '32',
    options: [
      { name: 'member', description: 'The Discord member to add', type: 6, required: true },
      {
        name: 'psn-id',
        description: 'Their PSN online ID, spelled exactly as on their profile',
        type: 3,
        required: true,
      },
    ],
  },
  {
    name: 'contested',
    description: 'What we are all still stuck on, and paying the most for right now',
  },
  {
    name: 'flag',
    description: 'Mods only. Mark a game, one edition, or one trophy as no longer earnable',
    // MANAGE_MESSAGES (8192), NOT Manage Server like /unlink and /addmember.
    // Those two rewrite who somebody is on the board; this moderates content,
    // which is the same authority as deleting a message. Leon was made a mod
    // and still could not run it, because a normal Mod role does not carry
    // Manage Server and has no reason to.
    default_member_permissions: '8192',
    options: [
      {
        name: 'game',
        description: 'The game to flag',
        type: 3,
        required: true,
        autocomplete: true,
      },
      {
        /**
         * PSN gives every edition its own trophy list, so GTA V on PS3, PS4 and
         * PS5 are three different games that happen to share a name. Leaving
         * this empty flags all of them, which is what a server shutdown usually
         * means and is what /flag has always done. Picking one is how a mod says
         * "only the PS3 list is broken", which they could not say before.
         */
        name: 'version',
        description: 'Which edition. Leave empty to flag every version of the title',
        type: 3,
        required: false,
        autocomplete: true,
      },
      {
        /**
         * Requires a version on any title with more than one edition. Trophy ids
         * are only unique inside one np_comm_id, so guessing which edition a
         * trophy belongs to would silently flag the wrong game's trophy.
         */
        name: 'trophy',
        description: 'One trophy rather than the whole game. Hits every edition unless you pick a version',
        type: 3,
        required: false,
        autocomplete: true,
      },
      {
        name: 'note',
        description: 'What is unobtainable and why. Leave empty to clear the flag',
        type: 3,
        required: false,
      },
      {
        // A separate field rather than asking mods to write the date into the
        // note. Prose cannot be counted down from, and the countdown is the
        // entire reason this exists: "dead" is a warning, "12 days left" is a
        // plan for the weekend.
        name: 'closes',
        description: 'Date the trophies die, YYYY-MM-DD. Sets the countdown instead of the dead flag',
        type: 3,
        required: false,
      },
    ],
  },
  {
    name: 'supporter',
    description: 'Mods only. Give somebody the supporter star, or set how many months they have given',
    // Same authority as /flag: MANAGE_MESSAGES. This decorates a name, it does
    // not rewrite who somebody is on the board, so it does not need the heavier
    // Manage Server that /unlink and /addmember carry.
    default_member_permissions: '8192',
    options: [
      {
        name: 'member',
        description: 'Who chipped in',
        type: 6,
        required: true,
      },
      {
        // The TOTAL, not an increment. A mod setting the same number twice must
        // not double it — running a command again after a timeout is the most
        // ordinary thing in the world and it should be harmless.
        name: 'months',
        description: 'Total months they have supported. 0 removes the star',
        type: 4,
        required: true,
        min_value: 0,
        max_value: 600,
      },
    ],
  },
  {
    name: 'rivals',
    description: 'Your private watchlist: up to five hunters you are actually racing',
    options: [
      {
        // ONE COMMAND, NOT FOUR. `/rivals` on its own shows the board; adding
        // an option does the thing AND shows the board. Subcommands would make
        // somebody learn `/rivals show` before they could see anything, to
        // separate operations that always end in the same place.
        name: 'add',
        description: 'A hunter to start watching',
        type: 3,
        required: false,
        autocomplete: true,
      },
      {
        name: 'remove',
        description: 'A hunter to stop watching',
        type: 3,
        required: false,
        autocomplete: true,
      },
    ],
  },
  {
    name: 'faq',
    description: 'How the board works: points, roles, joining, all of it',
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
    description: 'See who is just above and below you on the board',
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
          { name: 'Biggest prize', value: 'value' },
          { name: 'Nearly done', value: 'nearly' },
          { name: 'Best value', value: 'quick' },
          { name: 'Rarest first', value: 'rare' },
          // batzclaw: the cheapest games that are still worth something, for
          // an evening spent clearing the shelf rather than starting a monster.
          { name: 'Smallest jobs', value: 'small' },
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
