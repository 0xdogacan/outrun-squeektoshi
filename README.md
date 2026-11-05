# Hamster Race

**Can you outrun a hamster?** Run with your phone for 10 minutes against Squeektoshi, the hamster whose wheel mines blocks on [Squeekchain](https://docs.squeekchain.com/).

- **Ghost Race** (24/7): pick one of his real rounds from the last 7 days and race its ghost.
- **Live Race**: while he is on the wheel, join the next round as it happens. His official distance arrives once the round settles on Ethereum Sepolia.

No wallet, no token, no transaction, no betting.

## How the numbers are made

| Side | Source |
| --- | --- |
| Hamster work per round | SqueekCore `RoundRecorded(uint64 indexed roundId, uint64 work, …)` events on Sepolia. A settled round with no event had zero work. |
| Round clock | `genesisTimestamp` and `roundDuration` from `GET https://api.squeekchain.com/v1/core` |
| Wheel circumference | `WHEEL_CIRCUMFERENCE_MM` if set, otherwise the median of live readings `speedMmPerSecond × 60 ÷ RPM` from `/v1/status` |
| Hamster distance | work × circumference |
| Player distance | phone accelerometer step count × stride (entered, or 0.415 / 0.65 × height by cadence) |

The server always re-reads the hamster's settled work itself before saving a result. Player distance is self-reported; runs over 3.8 km in 10 minutes or above 4 steps/s are kept off the leaderboard.

## Layout

```
index.html, how.html, assets/   the site (plain HTML, CSS and JS modules, no build step)
lib/core.js                     shared logic: round clock, step counter, stride, verdicts
api/rounds.js                   GET  clock, live wheel state, calibration, ghost rounds
api/round.js                    GET  ?r=N official result of one round (or pending)
api/scores.js                   GET/POST leaderboard (Supabase)
api/_lib/                       Squeekchain + Sepolia RPC reads, Supabase client
supabase.sql                    database tables
tests/                          node --test
```

## Deploy (Vercel + Supabase)

1. **Supabase:** create a project, open SQL Editor, paste `supabase.sql`, run it. Copy the project URL and the `service_role` key (Project Settings → API).
2. **Vercel:** import this GitHub repo (framework preset: Other, no build command). Add environment variables:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - optional `WHEEL_CIRCUMFERENCE_MM` (skip it to calibrate from telemetry)
   - optional `SEPOLIA_RPC_URLS` (comma-separated, overrides the public defaults)
3. Deploy, then add your own domain in Vercel → Settings → Domains.

## Develop

```
npm test                    # unit + API tests with a mocked network
```

Open the site with `?sim=1` to practise without a phone: a simulated jog drives the race and the result is never sent to the leaderboard.

## Not affiliated

Fan-made for the Squeekchain Genesis builders. Squeektoshi runs when he wants to; nothing here asks anyone to disturb him.

## Squeekchain verification

squeekchain-project: d779732a-e18f-4ba5-ae3d-954f6dd896fd
