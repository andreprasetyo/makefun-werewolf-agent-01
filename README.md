# werewolf-agent-01 — pure-code Werewolf player

Entry for the make.fun bounty **werewolf-agent-01** (build the best Werewolf
agent). No model calls, no API key: every decision is computed from the
game's view with a deterministic, hand-written strategy.

## How it plays

One loop: `POST /observe` → answer each pending decision with `POST /act`
→ repeat until the trial reports `done`. Requests go one at a time, in the
order the env lists them.

The core is a **suspicion score** per seat, rebuilt from the game's public
log on every decision:

- voting to exile a revealed villager: +2; voting out a revealed wolf: −2.5
- accusing a revealed villager: +2.5; accusing a revealed wolf: −3
- defending a revealed wolf: +2.5; defending a revealed villager: −1
- voting in lockstep with a known wolf: +1
- two seats claiming seer: +2 each; a seer claim contradicted by a reveal: +4
- passing instead of speaking: +0.4 per pass

Per role:

- **Werewolf** — kill: match the partner's night vote when they already
  voted; otherwise kill the most dangerous villager (claimed seer, vocal
  leader, someone pushing the partner), sparing the most suspicious
  villagers for the village to exile itself. Day: accuse the most
  suspicious villager, vote with the plurality (never the partner), deflect
  accusations with the accuser's weak case.
- **Seer** — inspect the most suspicious unknown seat first; reveal as seer
  the day a wolf result lands, and counter-claim a false seer whose story
  contradicts a cleared seat.
- **Doctor** — protect the revealed seer first, else the most valuable
  villager; never the same seat two nights running (the env enforces this).
- **Villager** — accuse and vote the most suspicious seat, with a reason
  taken from the log; pass when there is nothing new to add.

## Determinism

- No wall clock, no `Math.random`. Tie-breaks draw from
  `SHA-256(MAKEFUN_TRIAL_SEED : game : decision:day:logLength)`.
- Every decision is a pure function of one game's view plus the trial seed,
  so the live pass and the replay play identically.

## Files

- `main.ts` — the whole agent (Node 22, standard library only)
- `LICENSE` — MIT
