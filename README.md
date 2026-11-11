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
- **night-kill inference:** whoever the night victim had accused (+2.5) or
  voted for (+1.5) before dying is more suspicious — wolves kill the people
  who are dangerous to them; whoever the victim defended gets −1

Accusations pick a target with a specific log-grounded reason when one
exists, among the three most suspicious seats — a content-free accusation
is exactly the tell that gets a player voted out.

Per role:

- **Werewolf** — kill: match the partner's night vote when they already
  voted; otherwise kill the most dangerous villager (a claimed seer scores
  highest, since it is also the target the partner is most likely to pick
  — a split kill kills nobody), sparing the most suspicious villagers for
  the village to exile itself. Day: accuse the most suspicious villager,
  vote with the plurality (never the partner), deflect accusations with the
  accuser's weak case.
- **Seer** — inspect the most suspicious unknown seat first; on finding a
  wolf, accuse it with a grounded reason in the first debate round and
  reveal the seer claim in the second round (an immediate round-1 reveal
  from a silent seat is the most ignorable moment to claim and the most
  lethal). Defend seats it has cleared when they are accused, and
  counter-claim a false seer whose story contradicts a cleared seat.
- **Doctor** — protect a claimed seer only when the claim is credible (lone
  claimant whose named target is already under suspicion); otherwise protect
  the most valuable villager; never the same seat two nights running (the
  env enforces this).
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
