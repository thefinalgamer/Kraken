# Platinum Intel — Nahasis rebuild

PSN trophy leaderboard bot for the Platinum Intel Discord. Rebuilds the original
bot's behaviour (`!update`, `!rank`, the movement feed, the fortnightly refresh)
and adds `/game` and `/backlog`.

## Status

| Piece | State |
|---|---|
| Rarity scoring engine | **done**, 9 tests passing |
| Database schema | **done** |
| PSN client + rate limiter | **done** |
| Scan job (`/update`) | **done** |
| Discord posting + Components V2 cards | **done** |
| GitHub Actions workflows | **done** |
| Worker: `/leaderboard`, `/rank`, `/game`, `/backlog`, `/register` | next |
| Setup guide | next |

Run the tests with `npm test`.

## How it fits together

```
Discord  ──/update──▶  Cloudflare Worker  ──dispatch──▶  GitHub Actions
                            │  (replies "queued" instantly)      │
                            │                                    │ scans PSN
                            ▼                                    ▼
                       Cloudflare D1  ◀────────────── writes results, edits
                       (members, games,                the original message
                        trophies, ranks)
```

The split exists because Cloudflare's free tier caps a Worker at 50 outbound
requests per invocation, and a full scan makes hundreds over several minutes.
Fast reads live in the Worker; slow work lives in Actions. Both free.

## Scoring

Rarity-weighted, `floor(100 / rarity% − 1)`, capped at 2,000 per trophy.

This was reverse-engineered from the old bot's own screenshots rather than
guessed. Three members with collections between 3,687 and 16,548 trophies all
score between 8.6 and 10.6 points per trophy — a flat 300/90/30/15 model
overshoots every one of them threefold. Keeping the formula means **nobody's
score changes when the bot comes back**.

The cap is the one deliberate deviation: uncapped, a single glitched 0.02%
trophy is worth ~5,000 points, more than a hundred ordinary platinums. Set
`cap: Infinity` in `shared/scoring.mjs` to match PSN100 exactly.

## Why points can go down

Rarity is recalculated live, so trophies devalue as the rest of the world
catches up — which is why RabbitSquared could earn three trophies and still lose
1,008 points. That behaviour is preserved, but the update card now splits the
number into "earned" and "drift" and says so in plain English instead of showing
a bare negative.

## The one manual chore

Sony has no public trophy API. Access needs an NPSSO cookie from a logged-in PSN
account, and the token it produces **expires roughly every two months**. The bot
DMs the owner three days beforehand with the four steps to refresh it. Everything
else is automatic.

## Cost

£0. Public repo (unlimited Actions minutes), Cloudflare Workers and D1 free
tiers, with a lot of headroom past a few hundred members.
