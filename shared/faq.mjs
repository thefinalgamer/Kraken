/**
 * The FAQ, and the text of Kraken's home page.
 *
 * Lives in shared/ because both halves need it: the job that publishes the home
 * message, and the Worker that answers when somebody picks from the dropdown.
 *
 * WHY A DROPDOWN RATHER THAN PINNED POSTS. Four walls of text pinned in a
 * channel is four walls of text. A select menu is one tidy message that answers
 * privately, so the channel stays readable and nobody scrolls past the bit they
 * needed. The cost is Discord search — text inside a component is not indexed —
 * which is why the plain-text version is still worth pinning underneath for
 * anyone searching "private profile" at midnight.
 *
 * THE SCORING SECTION IS GENERATED, NOT WRITTEN. Those numbers changed three
 * times in the first day. A hand-written table would have been confidently
 * wrong within hours and nobody would have noticed for weeks — so it reads the
 * same config the scoring uses, and cannot disagree with the board.
 */

import { trophyPoints, DEFAULT_SCORING, LOCAL_RARITY, localMultiplier } from './scoring.mjs';

const scoringTable = () => {
  const rows = [
    ['Over 50% of players have it', 0],
    ['25% — a decent platinum', trophyPoints(25)],
    ['10%', trophyPoints(10)],
    ['5%', trophyPoints(5)],
    ['1%', trophyPoints(1)],
    ['0.1% — proper ultra rare', trophyPoints(0.1)],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows
    .map(([label, points]) => `${label.padEnd(width)}  →  ${points} points`)
    .join('\n');
};

export const FAQ = [
  {
    value: 'joining',
    label: 'Getting on the board',
    description: 'Registering, verifying, private profiles, first scans',
    body:
      '## Getting on the board\n\n' +
      '**How do I join?**\n' +
      '`/register` with your PSN ID, then prove the account is yours. Two ways — hit the ' +
      'button to link your PlayStation account through Discord, or paste a short code into ' +
      'your PSN "About Me" for thirty seconds. Either is fine.\n\n' +
      '**Why do I have to verify?**\n' +
      'So nobody can claim your account. Without it, anyone could type your PSN ID and take ' +
      'your score.\n\n' +
      '**"Couldn\'t read your trophies"?**\n' +
      'Your trophy list is private. On PS5: **Settings → Users and Accounts → Privacy → ' +
      'Gaming | Media → Anyone.** Also check *who can see your gaming history* on the same ' +
      'page — set to No One it hides trophies even when the trophy setting looks right. ' +
      'Give it a few minutes, then `/update`.\n\n' +
      '**My first scan is taking ages.**\n' +
      'It reads your entire library — minutes for most people, hours if you own thousands of ' +
      'games. It happens once. Every update after is two or three minutes, and you can close ' +
      'Discord while it runs.\n\n' +
      '**Do I have to keep running /update?**\n' +
      'No. Everyone is refreshed automatically once a week, and the whole board is re-priced ' +
      'every night. `/update` is for when you want your new trophies showing *now*.',
  },
  {
    value: 'movement',
    label: 'Why my points did that',
    description: 'Went up, went down, and why we disagree with PSNProfiles',
    body:
      '## Why my points did that\n\n' +
      '**They went UP and I didn\'t play anything.**\n' +
      'Someone else started a game you have finished, and got stuck on it. Trophies are worth ' +
      'more while people here are still working on them. Your score moving because of what ' +
      'other people do is the whole point of this board.\n\n' +
      '**They went DOWN.**\n' +
      '▫️ Somebody finished a game you both own, so it is back to its normal value\n' +
      '▫️ You started a new game — that lowers your completion %, which pays out across your ' +
      'entire library\n' +
      '▫️ A trophy you own got more common worldwide\n\n' +
      'Nothing is ever taken away. `/update` shows you the split every time.\n\n' +
      '**This doesn\'t match PSNProfiles.**\n' +
      'It won\'t, and it isn\'t meant to. They count every trophy equally. We don\'t count easy ' +
      'ones at all, and we adjust for how rare something is *in this server*.\n\n' +
      '**My completion % is lower than PSNProfiles.**\n' +
      'Games worth zero points don\'t count toward it. If you have platted 100 cheap games, ' +
      'PSNProfiles counts all 100 and we count none. Buying games shouldn\'t raise your ' +
      'percentage — only finishing real ones should.',
  },
  {
    value: 'scoring',
    label: 'How scoring works',
    description: 'The three rules, with the current numbers',
    body: () =>
      '## How scoring works\n\n' +
      'Three rules.\n\n' +
      '**1. Only hard trophies pay.**\n' +
      'A trophy is worth what its worldwide rarity says.\n' +
      '```\n' + scoringTable() + '\n```\n' +
      'A shelf full of cheap auto-plats gets you **nothing** — not "a bit", nothing. If no ' +
      'trophy in a game is hard for anyone, the whole game is worth zero.\n\n' +
      '**2. Your mates make your games worth more.**\n' +
      'Every trophy is worth more while people here are still stuck on it, and settles back ' +
      'to normal once everyone who owns it has finished. You have platted Bloodborne, someone ' +
      'else starts it and gets stuck → **your Bloodborne is worth more.** They finish it → ' +
      'back to normal. A game plenty of us own and nobody has beaten is worth up to ' +
      `**${LOCAL_RARITY.cap}×**.\n\n` +
      '**3. Your completion % multiplies everything.**\n' +
      'At 60% you bank 60% of what your trophies are worth. At 61% you bank 61% — and that ' +
      'extra point applies to **every game you have ever touched**, including ones you have ' +
      'not opened in years.\n' +
      'It pays in **whole percentage points**, so it lands as one lump when you cross 61%, ' +
      'not a trickle while you climb towards it. Nothing happens at 60.1%, 60.4% or 60.9%; ' +
      'everything happens at 61%. `/rank` tells you which one you are chasing.\n' +
      'Finishing old games is the fastest way up this board. Starting things and walking away ' +
      'drags the multiplier down across your whole library.\n\n' +
      '-# These figures are read live from the scoring config, so they are always current.',
  },
  {
    value: 'board',
    label: 'The board, roles and commands',
    description: 'Where the leaderboard is, how roles work, what to type',
    body: (env) =>
      '## The board, roles and commands\n\n' +
      '**Where is the leaderboard?**\n' +
      (env?.DISCORD_LEADERBOARD_CHANNEL_ID
        ? `<#${env.DISCORD_LEADERBOARD_CHANNEL_ID}>`
        : 'The pinned board channel') +
      ' — everyone is on it, split across as many messages as it takes, and it updates ' +
      'itself. `/leaderboard` gives you a private look at the five people either side of you.\n\n' +
      '**Why can\'t people see my `/rank`?**\n' +
      'Everything except the board is private to you, so nobody\'s chat gets buried. There is ' +
      'a **Share to channel** button on `/rank` when you want to show off.\n\n' +
      '**How do the roles work?**\n' +
      'Automatically, from where you are on the board.\n' +
      '🏆 **Platinum** — 1st, one person only\n' +
      '🏆 **Gold** — top 10%\n' +
      '🏆 **Silver** — the next third\n' +
      '🏆 **Bronze** — everyone else\n' +
      'They update themselves. Nothing to ask for.\n\n' +
      '**Someone has claimed my PSN ID / I typed mine wrong.**\n' +
      'Ask a mod — `/unlink` frees it, then `/register` again.\n\n' +
      '**Commands**\n' +
      '`/rank` — where you are, and who you are chasing\n' +
      '`/leaderboard` — the five either side of you\n' +
      '`/backlog` — what to play next, ranked by what finishing it is worth\n' +
      '`/game` — what any game is worth, and who here has played it\n' +
      '`/contested` — what we are all still stuck on, and paying the most for right now\n' +
      '`/update` — rescan now\n' +
      '`/register` — put your PSN ID on the board\n' +
      '`/verify` — prove the account is yours and start your first scan\n' +
      '`/faq` — this menu, from anywhere\n\n' +
      '**Mods only**\n' +
      '`/flag` — mark a game as having trophies nobody can earn any more\n' +
      '`/unlink` — free somebody\'s PSN link so it can be claimed again\n' +
      '`/addmember` — put somebody on the board by hand, skipping verification',
  },
];

/** The body for one section. Some are functions so they can read live config. */
export const faqSection = (value, env) => {
  const entry = FAQ.find((f) => f.value === value);
  if (!entry) return null;
  return typeof entry.body === 'function' ? entry.body(env) : entry.body;
};

export const faqOptions = () =>
  FAQ.map(({ value, label, description }) => ({ value, label, description }));

/**
 * The home page blurb. Kept short on purpose — it is the first thing a new
 * member reads, and the detail is one click away in the dropdown.
 */
export const HOME_BLURB =
  'The trophy leaderboard is back.\n\n' +
  'Kraken scores your PlayStation trophies on how **hard** they are, not how many you have. ' +
  'Easy trophies pay nothing, rare ones pay properly, and your overall completion multiplies ' +
  'the lot — so going back and finishing old games is the fastest way up.\n\n' +
  'It also watches the whole server: a game gets **more valuable while people here are still ' +
  'stuck on it**, so your points move when other people play.';

export { DEFAULT_SCORING, localMultiplier };
