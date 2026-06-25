# lib/tier-builder.js — shared tier-rollup helper

**Not a cron.** A pure-math helper (no service, no IO, no chain queries, no
heartbeat). A metric cron calls it in memory to turn each run's numbers into the
rolling time-tiers; it returns the updated tiers. The math lives here once so
every module (aDAO-Data, NFT-Data, ...) borrows it instead of copy-pasting it.

## Use

```js
const TierBuilder = require('../lib/tier-builder.js');
let tiers = readTiersFromTlaCore();              // or {} on first run
tiers = TierBuilder.addReading(tiers, {
  t: Date.now(),          // ISO string or ms
  epoch: currentEpoch,    // from tla-snapshot / Eris period
  record: { tvl, members, vp, ... },   // this run's metric values (numbers)
});
writeTiersToTlaCore(tiers);                      // the cron persists it
```

`TierBuilder.current(tiers)` returns the latest raw record (what a tile reads).

## Tiers it builds

| field         | what                                                        |
|---------------|------------------------------------------------------------|
| `raw[]`       | the :00/:15/:30/:45 readings (capped ~200)                 |
| `hourly[]`    | avg of raw in each clock hour (finalized on hour change)    |
| `daily[]`     | avg of hourly in each day                                  |
| `monthly[]`   | avg of daily in each calendar month                        |
| `yearly[]`    | avg of monthly in each year                                |
| `epochly[]`   | avg of raw in each **epoch** (finalized on epoch change); each point tagged `.epoch` |
| `epoch_end{}` | `epoch_end[N]` = the **final reading** of epoch N, frozen once the epoch closes |

Calendar tiers use UTC clock/calendar boundaries (robust to a missed run). The
weekly tier is epoch-bucketed because TLA/Votion epochs don't align to clock marks.
A point appears only when its bucket **closes** (e.g. `hourly[0]` after hour 1 ends).

## Recent changes
- **1.0.0** — initial. 8-tier ladder, epoch bucketing, epoch-end freeze, boundary-based finalization. Unit-proven against a simulated clock (hour/day/month + epoch rollover).
