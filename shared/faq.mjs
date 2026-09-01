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
    ['25% - a decent platinum', trophyPoints(25)],
    ['10%', trophyPoints(10)],
    ['5%', trophyPoints(5)],
    ['1%', trophyPoints(1)],
    ['0.1% - proper ultra rare', trophyPoints(0.1)],
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
      '`/register` with your PSN ID, then prove the account is yours. Two ways. Hit the ' +
      'button to link your PlayStation account through Discord, or paste a short code into ' +
      'your PSN "About Me" for thirty seconds. Either is fine.\n\n' +
      '**Why do I have to verify?**\n' +
      'So nobody can claim your account. Without it, anyone could type your PSN ID and take ' +
      'your score.\n\n' +
      '**"Couldn\'t read your trophies"?**\n' +
      'Your trophy list is private. On PS5: **Settings → Users and Accounts → Privacy → ' +
      'Gaming | Media → Anyone.** Also check *who can see your gaming history* on the same ' +
      'page. Set to No One it hides trophies even when the trophy setting looks right. ' +
      'Give it a few minutes, then `/update`.\n\n' +
      '**My first scan is taking ages.**\n' +
      'It reads your entire library. Minutes for most people, hours if you own thousands of ' +
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
      '▫️ You started a new game. That lowers your completion %, which pays out across your ' +
      'entire library\n' +
      '▫️ A trophy you own got more common worldwide\n\n' +
      'Nothing is ever taken away. `/update` shows you the split every time.\n\n' +
      '**This doesn\'t match PSNProfiles.**\n' +
      'It won\'t, and it isn\'t meant to. They count every trophy equally. We don\'t count easy ' +
      'ones at all, and we adjust for how rare something is *in this server*.\n\n' +
      '**My completion % is lower than PSNProfiles.**\n' +
      'Games worth zero points don\'t count toward it. If you have platted 100 cheap games, ' +
      'PSNProfiles counts all 100 and we count none. Buying games shouldn\'t raise your ' +
      'percentage. Only finishing real ones should.',
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
      'A shelf full of cheap auto-plats gets you **nothing**, not "a bit", nothing. If no ' +
      'trophy in a game is hard for anyone, the whole game is worth zero.\n\n' +
      '**2. Your mates make your games worth more.**\n' +
      'Every trophy is worth more while people here are still stuck on it, and settles back ' +
      'to normal once everyone who owns it has finished. You have platted Bloodborne, someone ' +
      'else starts it and gets stuck → **your Bloodborne is worth more.** They finish it → ' +
      'back to normal. A game plenty of us own and nobody has beaten is worth up to ' +
      `**${LOCAL_RARITY.cap}×**.\n\n` +
      '**3. Your completion % multiplies everything.**\n' +
      'At 60% you bank 60% of what your trophies are worth. At 61% you bank 61%, and that ' +
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
      '. Everyone is on it, split across as many messages as it takes, and it updates ' +
      'itself. `/leaderboard` gives you a private look at the five people either side of you.\n\n' +
      '**Why can\'t people see my `/rank`?**\n' +
      'Everything except the board is private to you, so nobody\'s chat gets buried. There is ' +
      'a **Share to channel** button on `/rank` when you want to show off.\n\n' +
      '**How do the roles work?**\n' +
      'Automatically, from where you are on the board.\n' +
      '🏆 **Platinum** - 1st, one person only\n' +
      '🏆 **Gold** - top 10%\n' +
      '🏆 **Silver** - the next third\n' +
      '🏆 **Bronze** - everyone else\n' +
      'They update themselves. Nothing to ask for.\n\n' +
      '**Someone has claimed my PSN ID / I typed mine wrong.**\n' +
      'Ask a mod - `/unlink` frees it, then `/register` again.\n\n' +
      '**What does the ⚠️ on a game mean?**\n' +
      'Some of its trophies cannot be earned any more. Usually the online servers ' +
      'were switched off, sometimes an event ended or a patch broke something. The ' +
      'note tells you which.\n' +
      'PlayStation does not publish this, so it comes from **PSNP+**, a list ' +
      'crowd-sourced by trophy hunters who hit the wall and wrote it down: ' +
      'psnp-plus.huskycode.dev. Mods can add or clear a flag with `/flag`, and a mod ' +
      'always overrules the list.\n\n' +
      '**And the ⏳ or 🕒?**\n' +
      'That game is still finishable, but not for ever. A mod has put a date on it — ' +
      'servers closing, a licence expiring — and the clock counts down to it.\n' +
      '⏳ means **under a month left**. 🕒 means further out. When the date passes it ' +
      'becomes ⚠️ on its own, overnight.\n' +
      'The difference matters: ⚠️ is a closed door, ⏳ is an invitation with a deadline. ' +
      'Closing games sort to the top of `/contested`, because a deadline beats a ' +
      'difficulty ranking every time.\n\n' +
      '**Commands**\n' +
      '`/rank` - where you are, and who you are chasing\n' +
      '`/leaderboard` - the five either side of you\n' +
      '`/backlog` - what to play next, ranked by what finishing it is worth\n' +
      '`/game` - what any game is worth, and who here has played it\n' +
      '`/contested` - what we are all still stuck on, and paying the most for right now\n' +
      '`/update` - rescan now\n' +
      '`/register` - put your PSN ID on the board\n' +
      '`/verify` - prove the account is yours and start your first scan\n' +
      '`/faq` - this menu, from anywhere\n\n' +
      '**Mods only**\n' +
      '`/flag` - mark a game as having trophies nobody can earn any more, or put a ' +
      'closing date on one\n' +
      '`/supporter` - give somebody the supporter star\n' +
      '`/unlink` - free somebody\'s PSN link so it can be claimed again\n' +
      '`/addmember` - put somebody on the board by hand, skipping verification',
  },
  {
    value: 'website',
    label: 'The website',
    description: 'The board, game pages, the dice, and your rivals',
    body:
      '## The website\n\n' +
      'Everything the bot knows, with room to breathe. Discord is still the hub — you ' +
      'join here, you update here, the board posts here. The site is the window.\n\n' +
      '**Where is it?**\n' +
      'platinumintel.co.uk\n\n' +
      '**Do I need an account?**\n' +
      'No, and there is nothing to sign up for. If you are on the board you are already ' +
      'on the site. Nobody joins from there.\n\n' +
      '**What is on it?**\n' +
      '▫️ **Leaderboards** - the whole board, sortable by any column. Streamer and ' +
      'seasonal boards are coming\n' +
      '▫️ **Your page** - every game you own, what each is worth, and what finishing it ' +
      'would pay. Click any name on the board\n' +
      '▫️ **Game pages** - every trophy in a game, how rare it is worldwide AND how many ' +
      'of us have it, split into the base game and each DLC pack\n' +
      '▫️ **The dice** - stuck for something to play? Three from your backlog, two from ' +
      'games you have never touched\n\n' +
      '**"How many of us have it" — what is that?**\n' +
      'The column no other trophy site can show you. Every trophy says how many people ' +
      '*on this server* have earned it. "Four of us have this" is a different fact from ' +
      '"2% of the world has this", and it is usually the more interesting one.\n\n' +
      '**Secret trophies?**\n' +
      'Blurred until you ask. One button at the top of the list reveals the lot, so you ' +
      'cannot be spoiled by accident scrolling a game you have not played.\n\n' +
      '**Why is half the trophy list faded?**\n' +
      'Because you clicked through from somebody\'s page, so it is showing *their* ' +
      'trophies — earned ones lit, the rest dimmed. The chip at the top says whose. ' +
      'Click the ✕ to see the plain list.\n\n' +
      '**What are rivals?**\n' +
      'Up to five hunters you want to keep an eye on. Set them in Discord with ' +
      '`/rivals add`, and they show on your page as a little board of just them and ' +
      'you — rank, points, and how far ahead or behind each one is. Everyone can see ' +
      'everybody\'s, so being chased is part of it.\n\n' +
      '**The points on a game page look lower than the game is worth. Why?**\n' +
      'Because they are *yours*, not the game\'s. A game worth 1,400 pays you 1,400 ' +
      'at 100% completion and 980 at 70% — so the number beside your name is what it ' +
      'actually adds to your score. Two people with the same trophies and different ' +
      'completions see different numbers, and that is the multiplier doing its job.\n\n' +
      '**Can I see it on my phone?**\n' +
      'Yes. All of it.',
  },
  {
    value: 'supporting',
    label: 'Supporting Kraken',
    description: 'Costs, the star, and what it does not buy',
    body:
      '## Supporting Kraken\n\n' +
      'Kraken is free and always will be. There is nothing behind a paywall, no board ' +
      'you cannot see, and no advantage anybody can buy.\n\n' +
      '**So why is there a link?**\n' +
      'Hosting costs real money every month and somebody pays it. If you want to chip ' +
      'in there is a Ko-fi link in the footer of the site. If you do not, nothing about ' +
      'Kraken changes for you — that is the deal.\n\n' +
      '**What is the star next to some names?**\n' +
      'A thank-you. Bronze from the first month, silver at three, gold at six, platinum ' +
      'at a year. Once you have it you keep it, even if you stop — it says *you helped*, ' +
      'not *you are currently paying*.\n\n' +
      '**Does it get me anything?**\n' +
      '**No.** Not points, not rank, not tier, not a nudge up the board, not early ' +
      'access to anything. It is a small star beside your name and that is the entire ' +
      'feature. The board is a record of what people earned; the day it becomes ' +
      'something you can buy into, it is worth nothing to anybody.\n\n' +
      '**Do you see my card details?**\n' +
      'No. Ko-fi handles all of it. The only thing that reaches Kraken is a number of ' +
      'months, typed in by a mod. There is no payment information in the database at ' +
      'all.',
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
  'the lot, so going back and finishing old games is the fastest way up.\n\n' +
  'It also watches the whole server: a game gets **more valuable while people here are still ' +
  'stuck on it**, so your points move when other people play.\n\n' +
  'The full board, every game and every trophy is at **platinumintel.co.uk** — no ' +
  'account needed, you are already on it.';

export { DEFAULT_SCORING, localMultiplier };
