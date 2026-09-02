# Setup

Four free accounts and some copy-pasting. No code to write, nothing to install
on your own machine. Budget about 45 minutes.

## The short version

**Steps 1–5 you have to do yourself** — creating accounts and collecting values.
There's no way round that; they need your email, your password and your consent.

**Steps 6–10 are one command.** Once you've got the values, open your repo in a
GitHub Codespace (*Code ▾ → Codespaces → Create codespace* — free, runs in the
browser, nothing to install) and run:

```bash
npm install && npm run setup
```

It asks for each value, checks it as you paste it, then creates the database,
applies the schema, stores every secret, deploys the Worker and registers the
slash commands. Roughly ten minutes of pasting instead of an hour of clicking.

Everything below is the manual path, kept in case a step fails and you want to
see what the script was doing.

---

Work through it in order — later steps need values from earlier ones. Keep a
notepad open; you'll be collecting eight values along the way.

---

## What you'll end up with

```
Discord ──slash commands──▶ Cloudflare Worker ──▶ GitHub Actions ──▶ PSN
                                    │                    │
                                    └──── Cloudflare D1 ◀┘
```

---

## Step 1 — A PSN account for the bot to authenticate with

The bot reads PSN through a logged-in session, so it needs an account of its own.

- A **throwaway account is better** than your main one. It doesn't need trophies,
  friends, or PS Plus — it only needs to be able to view public profiles.
- **Do not use an account with a payment card attached.**

Create one at [playstation.com](https://www.playstation.com) if you haven't got a
spare, and sign in to it in a browser you can come back to.

---

## Step 2 — GitHub

1. Sign up at [github.com](https://github.com) if you need to.
2. Create a **new repository** called `platinum-intel`. Make it **public** —
   public repos get unlimited Actions minutes, private ones get 2,000/month and
   the fortnightly refresh alone would eat most of that.
3. Upload the project files (drag and drop works: *Add file → Upload files*).

> Member PSN IDs live in Cloudflare, not in the repo, so a public repo doesn't
> expose anyone's account.

📝 **Note down:** your repo name in `owner/name` form, e.g. `martin/platinum-intel`.

---

## Step 3 — Cloudflare

1. Sign up at [dash.cloudflare.com](https://dash.cloudflare.com).
2. **Workers & Pages → D1 → Create database**, name it `platinum-intel`.
3. Open the database, go to the **Console** tab, paste the entire contents of
   `schema.sql`, and run it.

📝 **Note down:**
- **Account ID** — right-hand sidebar of the Workers & Pages overview
- **Database ID** — on the D1 database page
- **API token** — *My Profile → API Tokens → Create Token → Edit Cloudflare
  Workers* template. Copy it immediately; it's shown once.

---

## Step 4 — The Discord application

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
   → **New Application**, call it **Kraken**.
2. Upload the old bot's avatar if you still have it — nice touch for returning members.
3. **Bot** tab → **Reset Token** → copy it.
4. Still on the Bot tab, enable **Server Members Intent**.
5. **OAuth2 → URL Generator**: tick `bot` and `applications.commands`, then under
   permissions tick **Send Messages**, **Embed Links**, **Create Public Threads**,
   **Send Messages in Threads**, **Read Message History**. Open the generated URL
   and add the bot to your server.

📝 **Note down:** Application ID, Public Key (both on *General Information*), and
the Bot Token.

You'll also need some Discord IDs. Turn on *Settings → Advanced → Developer Mode*,
then right-click to copy:

- your **server ID** (right-click the server name)
- the **channel ID** for updates
- the **channel ID** for the movement feed
- **your own user ID** (for the token-expiry warnings)
- a **role ID** for the soft launch — make a role like `Trophy Hunter` and only
  people with it can `/register` while you're testing

---

## Step 5 — The NPSSO cookie

This is the one that expires. **You'll redo this roughly every two months** —
the bot DMs you three days beforehand, so you're never caught out.

1. In a browser, sign in to [playstation.com](https://www.playstation.com) with
   the account from Step 1.
2. In the same browser, visit:
   `https://ca.account.sony.com/api/v1/ssocookie`
3. You'll see something like `{"npsso":"AbCdEf123..."}`. Copy the value between
   the quotes — not the whole thing.

📝 **Note down:** the NPSSO value.

---

## Step 6 — Load the secrets into GitHub

In your repo: **Settings → Secrets and variables → Actions**.

Under **Secrets** → *New repository secret*, add:

| Name | Value |
|---|---|
| `PSN_NPSSO` | from Step 5 |
| `CF_ACCOUNT_ID` | from Step 3 |
| `CF_D1_DATABASE_ID` | from Step 3 |
| `CF_API_TOKEN` | from Step 3 |
| `DISCORD_BOT_TOKEN` | from Step 4 |
| `DISCORD_APPLICATION_ID` | from Step 4 |

Under **Variables** → *New repository variable*, add:

| Name | Value |
|---|---|
| `DISCORD_UPDATES_CHANNEL_ID` | your updates channel |
| `DISCORD_LEADERBOARD_CHANNEL_ID` | your movement feed channel |
| `DISCORD_OWNER_ID` | your own user ID |
| `DISCORD_DIGEST_CHANNEL_ID` | *optional.* Where the Monday digest goes. Unset, it posts to the updates channel with everything else, which is where it gets lost: that channel takes a card every time anybody scans, and the digest is meant to be scrolled back through week by week. Give it a channel of its own. |

---

## Step 7 — Deploy the Worker

Easiest in Cloudflare's browser terminal, or locally if you have Node installed:

```bash
npm install
npx wrangler login
```

Edit `wrangler.toml` and paste your D1 database ID into `database_id`, and your
soft-launch role ID into `HUNTER_ROLE_ID`.

```bash
npx wrangler secret put DISCORD_PUBLIC_KEY      # from Step 4
npx wrangler secret put DISCORD_APPLICATION_ID  # from Step 4
npx wrangler secret put GITHUB_TOKEN            # see below
npx wrangler secret put GITHUB_REPO             # e.g. martin/platinum-intel
npx wrangler deploy
```

For `GITHUB_TOKEN`: GitHub → *Settings → Developer settings → Personal access
tokens → Fine-grained tokens*. Scope it to just this repository, and give it
**Contents: Read and write**. That's the permission that lets the Worker kick
off a scan.

Deploy prints a URL like `https://platinum-intel.<you>.workers.dev`. Copy it.

---

## Step 8 — Point Discord at the Worker

Back on your Discord application's **General Information** page, paste that URL
into **Interactions Endpoint URL** and save.

Discord immediately sends a signed test request. If it saves, the connection
works. If it refuses, the public key is wrong — recheck Step 7.

---

## Step 9 — Register the commands

```bash
DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... \
  npm run register-commands
```

Passing your server ID makes the commands appear instantly in that server only,
which is what you want while testing. Without it, Discord takes up to an hour to
roll them out everywhere.

---

## Step 10 — Try it

1. Give yourself the `Trophy Hunter` role.
2. Run `/register psn-id: <your PSN ID>`.
3. Wait. Your first scan is the slow one — 15 to 30 minutes, because nothing
   about your library is cached yet.
4. When it lands, **check your points against your PSNProfiles page.** They
   won't match exactly (different formula), but your trophy counts and
   completion percentage should match to the digit. If they don't, stop and
   tell me before letting anyone else in.

Then invite people a handful at a time. Each new member's first scan is cheaper
than the last, because they'll share games with people already on the board.

---

## When something breaks

**"Application did not respond"** — the Worker isn't reachable. Check it's
deployed and the endpoint URL is right.

**Registration goes quiet and nothing appears** — nine times out of ten the
member's PSN trophies are private. *Settings → Users and Accounts → Privacy →
Trophies → Anyone.*

**Updates stop server-wide** — the NPSSO has expired. Redo Step 5 and update the
`PSN_NPSSO` secret. This is the two-monthly chore.

**Scans failing with 429** — PSN is rate-limiting. The client already backs off
and retries; if it persists, something else is using the same PSN account.

Actions logs are under the **Actions** tab in your repo, and they say exactly
what happened on every scan.
