#!/usr/bin/env node
/**
 * Guided setup.
 *
 * Replaces most of SETUP.md. You still create the accounts and collect the
 * values yourself — nobody else should be doing that for you — but everything
 * after that (database, schema, secrets, deploy, command registration) happens
 * here in one go.
 *
 * Run it in a GitHub Codespace and you need nothing installed locally:
 *   your repo → Code ▾ → Codespaces → Create codespace
 *   then:  npm install && node setup.mjs
 *
 * It validates every value as you paste it, so typos get caught immediately
 * rather than surfacing as a silent failure three steps later.
 */

import { createInterface } from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { stdin, stdout } from 'node:process';

const rl = createInterface({ input: stdin, output: stdout });

const c = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const ok = (s) => console.log(`  ${c.green('✓')} ${s}`);
const warn = (s) => console.log(`  ${c.yellow('!')} ${s}`);
const die = (s) => {
  console.error(`\n  ${c.red('✗')} ${s}\n`);
  process.exit(1);
};

// ------------------------------------------------------------- validators --

const V = {
  snowflake: (v) => (/^\d{15,25}$/.test(v) ? null : 'should be a long number — turn on Developer Mode in Discord, then right-click to copy the ID'),
  hex64: (v) => (/^[0-9a-f]{64}$/i.test(v) ? null : 'should be 64 hex characters — that is the Public Key, not the Bot Token'),
  botToken: (v) => (v.split('.').length === 3 && v.length > 50 ? null : 'does not look like a bot token (three dot-separated parts)'),
  npsso: (v) =>
    v.startsWith('{') ? 'paste only the value inside the quotes, not the whole {"npsso":"..."} blob'
    : v.length < 30 ? 'looks too short — it should be a long random string'
    : null,
  cfId: (v) => (/^[0-9a-f]{32}$/i.test(v) ? null : 'should be 32 hex characters'),
  repo: (v) => (/^[\w.-]+\/[\w.-]+$/.test(v) ? null : 'should be in owner/name form, e.g. martin/platinum-intel'),
  token: (v) => (v.length > 20 ? null : 'looks too short'),
  optional: () => null,
};

async function ask(label, { validate = V.optional, hint, optional = false } = {}) {
  for (;;) {
    if (hint) console.log(c.dim(`     ${hint}`));
    const raw = (await rl.question(`  ${c.cyan('›')} ${label}: `)).trim();
    if (!raw && optional) return '';
    if (!raw) {
      console.log(`     ${c.red('required')}`);
      continue;
    }
    const problem = validate(raw);
    if (problem) {
      console.log(`     ${c.red(problem)}`);
      continue;
    }
    return raw;
  }
}

// ------------------------------------------------------------------ shell --

function run(cmd, args, { input, quiet = false, allowFail = false } = {}) {
  const res = spawnSync(cmd, args, {
    input,
    encoding: 'utf8',
    stdio: input !== undefined ? ['pipe', 'pipe', 'pipe'] : ['inherit', 'pipe', 'pipe'],
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  if (res.status !== 0 && !allowFail) {
    if (!quiet) console.error(out);
    die(`\`${cmd} ${args.slice(0, 2).join(' ')}\` failed.`);
  }
  return { ok: res.status === 0, out };
}

const has = (cmd) => spawnSync('which', [cmd], { encoding: 'utf8' }).status === 0;

// ------------------------------------------------------------------- main --

console.log(`
${c.b('Platinum Intel — setup')}
${c.dim('Everything after account creation, in one pass.')}
`);

// -- prerequisites ------------------------------------------------------------

console.log(c.b('Checking your tools'));
if (!has('node')) die('Node is not installed.');
ok(`node ${process.version}`);

const npx = (args, opts) => run('npx', ['--yes', ...args], opts);

if (!has('gh')) {
  die(
    'The GitHub CLI (`gh`) is not available.\n' +
      '    The easiest fix is to run this in a GitHub Codespace, where it is preinstalled:\n' +
      '    your repo → Code ▾ → Codespaces → Create codespace',
  );
}
ok('gh is installed');

if (!run('gh', ['auth', 'status'], { quiet: true, allowFail: true }).ok) {
  console.log(`\n  Not signed in to GitHub. Run ${c.b('gh auth login')} and then start this again.\n`);
  process.exit(1);
}
ok('signed in to GitHub');

// -- collect ------------------------------------------------------------------

console.log(`\n${c.b('Your repository')}`);
const repoGuess = run('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
  quiet: true,
  allowFail: true,
});
let repo = repoGuess.ok ? repoGuess.out.trim() : '';
if (repo) {
  const yes = (await rl.question(`  ${c.cyan('›')} Use ${c.b(repo)}? [Y/n]: `)).trim().toLowerCase();
  if (yes === 'n') repo = '';
}
if (!repo) repo = await ask('Repository (owner/name)', { validate: V.repo });
ok(repo);

console.log(`\n${c.b('Discord')} ${c.dim('— from discord.com/developers/applications')}`);
const discordAppId = await ask('Application ID', { validate: V.snowflake, hint: 'General Information tab' });
const discordPublicKey = await ask('Public Key', { validate: V.hex64, hint: 'same tab, 64 hex characters' });
const discordBotToken = await ask('Bot Token', { validate: V.botToken, hint: 'Bot tab → Reset Token' });
const guildId = await ask('Your server ID', { validate: V.snowflake, hint: 'right-click the server name → Copy Server ID' });
const updatesChannel = await ask('Channel ID for update posts', { validate: V.snowflake });
const feedChannel = await ask('Channel ID for the movement feed', { validate: V.snowflake });
const ownerId = await ask('Your own user ID', { validate: V.snowflake, hint: 'so the bot can DM you before the PSN login expires' });
const roleId = await ask('Soft-launch role ID', {
  validate: V.snowflake,
  optional: true,
  hint: 'only members with this role can /register — leave blank to open it to everyone',
});

console.log(`\n${c.b('Cloudflare')} ${c.dim('— from dash.cloudflare.com')}`);
const cfAccountId = await ask('Account ID', { validate: V.cfId, hint: 'sidebar of Workers & Pages' });
const cfApiToken = await ask('API Token', { validate: V.token, hint: 'My Profile → API Tokens → Edit Cloudflare Workers template' });

console.log(`\n${c.b('PlayStation')}`);
console.log(
  c.dim(
    '     Sign in at playstation.com, then open:\n' +
      '     https://ca.account.sony.com/api/v1/ssocookie\n' +
      '     Copy only the value inside the quotes.',
  ),
);
const npsso = await ask('NPSSO', { validate: V.npsso });

console.log(`\n${c.b('GitHub token')} ${c.dim('— lets the Worker start a scan')}`);
console.log(
  c.dim(
    '     Settings → Developer settings → Personal access tokens → Fine-grained\n' +
      `     Scope it to ${repo} only, with Contents: Read and write.`,
  ),
);
const ghToken = await ask('Fine-grained token', { validate: V.token });

rl.close();

// -- database -----------------------------------------------------------------

console.log(`\n${c.b('Creating the database')}`);
const cfEnv = { ...process.env, CLOUDFLARE_API_TOKEN: cfApiToken, CLOUDFLARE_ACCOUNT_ID: cfAccountId };
const wrangler = (args, opts = {}) =>
  spawnSync('npx', ['--yes', 'wrangler', ...args], { encoding: 'utf8', env: cfEnv, ...opts });

let databaseId = '';
const created = wrangler(['d1', 'create', 'platinum-intel']);
const createdOut = `${created.stdout ?? ''}${created.stderr ?? ''}`;
const idMatch = createdOut.match(/database_id\s*=\s*"([0-9a-f-]{36})"/i);

if (idMatch) {
  databaseId = idMatch[1];
  ok(`created database ${databaseId}`);
} else if (/already exists/i.test(createdOut)) {
  const list = wrangler(['d1', 'list', '--json']);
  const found = JSON.parse(`${list.stdout}`.match(/\[[\s\S]*\]/)?.[0] ?? '[]').find(
    (d) => d.name === 'platinum-intel',
  );
  if (!found) die('A database called platinum-intel exists but could not be read back.');
  databaseId = found.uuid ?? found.database_id;
  warn(`reusing existing database ${databaseId}`);
} else {
  console.error(createdOut);
  die('Could not create the D1 database. The most likely cause is an API token without D1 permission.');
}

const schema = wrangler(['d1', 'execute', 'platinum-intel', '--remote', '--file=schema.sql', '-y']);
if (schema.status !== 0) {
  console.error(`${schema.stdout ?? ''}${schema.stderr ?? ''}`);
  die('Could not apply schema.sql.');
}
ok('schema applied');

// -- wrangler.toml ------------------------------------------------------------

if (!existsSync('wrangler.toml')) die('wrangler.toml is missing — run this from the project root.');
const toml = readFileSync('wrangler.toml', 'utf8')
  .replace(/database_id = ".*"/, `database_id = "${databaseId}"`)
  .replace(/HUNTER_ROLE_ID = ".*"/, `HUNTER_ROLE_ID = "${roleId}"`);
writeFileSync('wrangler.toml', toml);
ok('wrangler.toml updated');

// -- secrets ------------------------------------------------------------------

console.log(`\n${c.b('Storing secrets')}`);

for (const [name, value] of [
  ['DISCORD_PUBLIC_KEY', discordPublicKey],
  ['DISCORD_APPLICATION_ID', discordAppId],
  ['GITHUB_TOKEN', ghToken],
  ['GITHUB_REPO', repo],
]) {
  const res = wrangler(['secret', 'put', name], { input: `${value}\n` });
  if (res.status !== 0) die(`Could not set Worker secret ${name}.`);
}
ok('4 Worker secrets set');

for (const [name, value] of [
  ['PSN_NPSSO', npsso],
  ['CF_ACCOUNT_ID', cfAccountId],
  ['CF_D1_DATABASE_ID', databaseId],
  ['CF_API_TOKEN', cfApiToken],
  ['DISCORD_BOT_TOKEN', discordBotToken],
  ['DISCORD_APPLICATION_ID', discordAppId],
]) {
  run('gh', ['secret', 'set', name, '--repo', repo, '--body', value], { quiet: true });
}
ok('6 repository secrets set');

for (const [name, value] of [
  ['DISCORD_UPDATES_CHANNEL_ID', updatesChannel],
  ['DISCORD_LEADERBOARD_CHANNEL_ID', feedChannel],
  ['DISCORD_OWNER_ID', ownerId],
]) {
  run('gh', ['variable', 'set', name, '--repo', repo, '--body', value], { quiet: true });
}
ok('3 repository variables set');

// -- deploy -------------------------------------------------------------------

console.log(`\n${c.b('Deploying')}`);
const deploy = wrangler(['deploy']);
const deployOut = `${deploy.stdout ?? ''}${deploy.stderr ?? ''}`;
if (deploy.status !== 0) {
  console.error(deployOut);
  die('Deploy failed.');
}
const workerUrl = deployOut.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0];
ok(`worker deployed${workerUrl ? ` at ${workerUrl}` : ''}`);

// -- commands -----------------------------------------------------------------

const reg = spawnSync(process.execPath, ['jobs/register-commands.mjs'], {
  encoding: 'utf8',
  env: {
    ...process.env,
    DISCORD_APPLICATION_ID: discordAppId,
    DISCORD_BOT_TOKEN: discordBotToken,
    DISCORD_GUILD_ID: guildId,
  },
});
if (reg.status !== 0) {
  console.error(`${reg.stdout ?? ''}${reg.stderr ?? ''}`);
  die('Could not register the slash commands. The bot token is the likely culprit.');
}
ok('slash commands registered to your server');

// -- done ---------------------------------------------------------------------

console.log(`
${c.green(c.b('Done.'))} One thing left that only you can do:

  ${c.b('1.')} Go to your Discord application → General Information
  ${c.b('2.')} Paste this into ${c.b('Interactions Endpoint URL')} and save:

       ${c.cyan(workerUrl ?? 'the workers.dev URL printed above')}

  Discord sends a signed test request the moment you save. If it saves, you're live.

Then, in your server:

  ${c.b('•')} Give yourself the soft-launch role
  ${c.b('•')} Run ${c.b('/register psn-id: <your PSN ID>')}
  ${c.b('•')} Wait 15–30 minutes for the first scan

${c.yellow('Check your trophy counts and completion % against your PSNProfiles page')}
${c.yellow('before inviting anyone else. They should match to the digit.')}
`);
