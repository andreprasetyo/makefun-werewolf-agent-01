// werewolf-agent-01 — pure-code deterministic player (no model calls).
//
// Plays 30 games of 8-player Werewolf through the env at MAKEFUN_ENV_URL:
// POST /observe lists the decisions waiting on this seat, POST /act answers
// each one. No model is ever called: every decision is a pure function of
// the game's view (its public log plus this seat's private record) and the
// trial seed, so a replay serves the same requests and plays the same games.
//
// Strategy in one paragraph: keep a suspicion score for every seat, updated
// from the public log (votes that exiled revealed villagers, defences of
// revealed wolves, seer claims and counter-claims, silence), then act on it
// per role. As a wolf, kill the most dangerous villager (a claimed seer, a
// vocal leader, someone pushing on the partner) and match the partner's
// night vote; by day, blend in, accuse the most suspicious villager and vote
// with the majority. As the seer, inspect the most suspicious seat first and
// reveal with a wolf result. As the doctor, protect the revealed seer or the
// most valuable villager, never the same seat two nights running. As a
// villager, accuse and vote the most suspicious seat, with a reason taken
// from the log. Statements stay under the limit, are never empty, and a
// refused action is re-sent as a valid one.
//
// Determinism: no wall clock (no Date.now, no timers in any request), no
// Math.random (tie-breaks draw from SHA-256(MAKEFUN_TRIAL_SEED : game :
// label)), and requests go to the env one at a time, in the order /observe
// lists them, so nothing depends on reply order or timing.
//
// Run by the grader as `node /bot/main.ts`; Node 22 standard library only.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

type Seat = number;
type Role = 'werewolf' | 'seer' | 'doctor' | 'villager';
type DecisionKind = 'speak' | 'vote' | 'kill' | 'protect' | 'inspect';

interface LogEntry {
  seq: number;
  day: number;
  kind: string;
  seat?: Seat;
  target?: Seat | null;
  text?: string;
  round?: number;
  died?: Seat | null;
  role?: string | null;
  order?: Seat[];
  tally?: { seat: Seat; votes: number }[];
  winner?: string | null;
  [k: string]: unknown;
}

interface PlayerInfo {
  seat: Seat;
  name: string;
  alive: boolean;
  role: string | null;
}

interface View {
  day: number;
  phase: string;
  you: { seat: Seat; name: string; role: Role; alive: boolean; partner: { seat: Seat; name: string; alive: boolean } | null };
  players: PlayerInfo[];
  seerResults: { night: number; seat: Seat; werewolf: boolean }[] | null;
  lastProtect: { night: number; seat: Seat } | null;
  wolfVotes: { night: number; seat: Seat; target: Seat | null }[] | null;
  log: LogEntry[];
  outcome: { winner: string | null; reason: string; day: number; winners: Seat[] } | null;
}

interface Pending {
  game: number;
  decision: DecisionKind;
  options?: Seat[];
  max_chars?: number;
  view: View;
}

interface Observed {
  games: number;
  finished: number;
  done: boolean;
  pending: Pending[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** A statement folded to one line the env's way. */
export function foldStatement(text: string): string {
  return text
    .replace(/[\t\n\v\f\r\u0085\u2028\u2029]+/g, ' ')
    .replace(/\p{Cc}/gu, '')
    .trim();
}

/**
 * Deterministic PRNG seeded from the trial seed, the game number and a
 * label: the same seed and game always give the same stream, in both the
 * live pass and the replay. Only used to break ties.
 */
export function rngFor(seed: string, game: number, label: string): () => number {
  const digest = createHash('sha256').update(`${seed}:${game}:${label}`).digest();
  let s = digest.readUInt32LE(0) >>> 0;
  if (s === 0) s = 0x9e3779b9;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Pick the best candidate by score, breaking ties with the seeded stream. */
function bestBy<T>(items: T[], score: (x: T) => number, rng: () => number): T | null {
  let best: T | null = null;
  let bestKey = -Infinity;
  for (const item of items) {
    // A tiny seeded nudge (under 0.001) breaks ties without ever
    // outweighing a real score difference.
    const key = score(item) + rng() * 0.000999;
    if (key > bestKey) {
      bestKey = key;
      best = item;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Log analysis: everything below is a pure function of one game's view.
// ---------------------------------------------------------------------------

interface Accusation {
  day: number;
  from: Seat;
  target: Seat;
  kind: 'accuse' | 'defend';
}

interface Analysis {
  me: Seat;
  role: Role;
  partner: Seat | null;
  alive: Seat[];
  dead: Map<Seat, string>; // seat -> revealed role
  knownWolves: Set<Seat>;
  knownVillagers: Set<Seat>; // revealed non-wolves + seer-cleared seats
  seerClaimants: Seat[];
  suspicion: Map<Seat, number>;
  speeches: Map<Seat, number>;
  passes: Map<Seat, number>;
  accusations: Accusation[];
  votesFor: Map<Seat, Seat[]>; // target -> voters (all days, latest day first)
  votesToday: Map<Seat, number>; // target -> votes cast on the current day
  accusedMe: Seat[];
  defendedPartner: Seat[];
}

const ACCUSE_WORDS = /\b(wolf|wolves|suspicious|sus|guilty|evil|mafia|lynch|kill(?:er|ed)?|shady|fake|lying|liar)\b/i;
const DEFEND_WORDS = /\b(innocent|villager|trust|clear|not (?:a )?wolf|good|believe (?:him|her|them))\b/i;
const SEER_WORDS = /\b(seer|checked|inspect(?:ed|ing)?|saw (?:him|her|them))\b/i;

/** Seats a statement mentions, by "seat N" or by player name. */
function mentionedSeats(text: string, players: PlayerInfo[]): Seat[] {
  const out = new Set<Seat>();
  for (const m of text.matchAll(/seat\s+(\d+)/gi)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 8) out.add(n);
  }
  const lower = text.toLowerCase();
  for (const p of players) {
    if (p.name && lower.includes(p.name.toLowerCase())) out.add(p.seat);
  }
  return [...out];
}

export function analyze(view: View): Analysis {
  const me = view.you.seat;
  const role = view.you.role;
  const partner = view.you.partner ? view.you.partner.seat : null;
  const alive = view.players.filter((p) => p.alive).map((p) => p.seat);
  const dead = new Map<Seat, string>();
  for (const p of view.players) {
    if (!p.alive && p.role) dead.set(p.seat, p.role);
  }
  // Deaths in the log also reveal roles (dawn / exile entries).
  for (const e of view.log) {
    if ((e.kind === 'dawn' || e.kind === 'exile') && typeof e.seat === 'number' && e.role) {
      dead.set(e.seat, String(e.role));
    }
    if (e.kind === 'dawn' && typeof e.died === 'number' && e.role) {
      dead.set(e.died, String(e.role));
    }
  }
  const knownWolves = new Set<Seat>();
  const knownVillagers = new Set<Seat>();
  for (const [seat, r] of dead) {
    if (r === 'werewolf') knownWolves.add(seat);
    else knownVillagers.add(seat);
  }
  if (view.seerResults) {
    for (const r of view.seerResults) {
      if (r.werewolf) knownWolves.add(r.seat);
      else knownVillagers.add(r.seat);
    }
  }

  const suspicion = new Map<Seat, number>();
  const speeches = new Map<Seat, number>();
  const passes = new Map<Seat, number>();
  const accusations: Accusation[] = [];
  const votesFor = new Map<Seat, Seat[]>();
  const votesToday = new Map<Seat, number>();
  const seerClaimants: Seat[] = [];
  const accusedMe: Seat[] = [];
  const defendedPartner: Seat[] = [];

  const bump = (seat: Seat, n: number) => {
    if (seat === me) return; // never score ourselves
    suspicion.set(seat, (suspicion.get(seat) ?? 0) + n);
  };

  // Day-by-day walk: an accusation or vote only counts against what was
  // known when it was made, so the walk keeps a "revealed so far" set.
  const revealedSoFar = new Map<Seat, string>();
  for (const e of view.log) {
    if (e.kind === 'speech' && typeof e.seat === 'number' && typeof e.text === 'string') {
      const seat = e.seat;
      speeches.set(seat, (speeches.get(seat) ?? 0) + 1);
      const targets = mentionedSeats(e.text, view.players).filter((t) => t !== seat);
      const isAccuse = ACCUSE_WORDS.test(e.text);
      const isDefend = DEFEND_WORDS.test(e.text);
      if (SEER_WORDS.test(e.text) && /\b(i am|i'm|me)\b/i.test(e.text) && !seerClaimants.includes(seat)) {
        seerClaimants.push(seat);
      }
      for (const t of targets) {
        if (isAccuse && !isDefend) {
          accusations.push({ day: e.day, from: seat, target: t, kind: 'accuse' });
          if (t === me) accusedMe.push(seat);
          if (t === partner) defendedPartner.push(seat); // someone pushing the partner
          const r = revealedSoFar.get(t);
          if (r === 'werewolf') bump(seat, -3); // right call: less suspicious
          else if (r) bump(seat, +2.5); // accused a revealed villager
        } else if (isDefend && !isAccuse) {
          accusations.push({ day: e.day, from: seat, target: t, kind: 'defend' });
          const r = revealedSoFar.get(t);
          if (r === 'werewolf') bump(seat, +2.5); // defended a revealed wolf
          else if (r) bump(seat, -1); // defended a revealed villager
        }
      }
    } else if (e.kind === 'pass' && typeof e.seat === 'number') {
      passes.set(e.seat, (passes.get(e.seat) ?? 0) + 1);
      bump(e.seat, 0.4); // quiet seats hide more easily
    } else if (e.kind === 'vote' && typeof e.seat === 'number' && typeof e.target === 'number') {
      const voters = votesFor.get(e.target) ?? [];
      voters.push(e.seat);
      votesFor.set(e.target, voters);
      if (e.day === view.day) votesToday.set(e.target, (votesToday.get(e.target) ?? 0) + 1);
      // A vote is judged by what the target turned out to be: the exile
      // (or night death) that reveals it always comes after the votes of
      // that day, so the timing-aware set would never see it.
      const r = dead.get(e.target);
      if (r === 'werewolf') bump(e.seat, -2.5); // voted a wolf out
      else if (r) bump(e.seat, +2); // voted a villager out
      // Voting in lockstep with a known wolf is a tell.
      for (const w of knownWolves) {
        if (w !== e.seat && (votesFor.get(e.target) ?? []).includes(w)) bump(e.seat, 1);
      }
    } else if (e.kind === 'dawn' && typeof e.died === 'number' && e.role) {
      revealedSoFar.set(e.died, String(e.role));
    } else if (e.kind === 'exile' && typeof e.seat === 'number' && e.role) {
      revealedSoFar.set(e.seat, String(e.role));
    }
  }

  // Seer claims: two claimants cannot both be telling the truth.
  if (seerClaimants.length > 1) {
    for (const s of seerClaimants) bump(s, 2);
  }
  // A claimant whose "check" contradicts a reveal is lying.
  for (const s of seerClaimants) {
    for (const e of view.log) {
      if (e.kind === 'speech' && e.seat === s && typeof e.text === 'string' && SEER_WORDS.test(e.text)) {
        for (const t of mentionedSeats(e.text, view.players)) {
          const r = dead.get(t);
          if (!r) continue;
          const calledWolf = ACCUSE_WORDS.test(e.text);
          if (calledWolf && r !== 'werewolf') bump(s, 4);
          if (!calledWolf && r === 'werewolf') bump(s, 4);
        }
      }
    }
  }
  // The real seer (me, when I am the seer) trusts my own results: clear
  // cleared seats, condemn found wolves.
  if (role === 'seer' && view.seerResults) {
    for (const r of view.seerResults) {
      suspicion.set(r.seat, r.werewolf ? 100 : -100);
    }
  }
  return {
    me, role, partner, alive, dead, knownWolves, knownVillagers,
    seerClaimants, suspicion, speeches, passes, accusations, votesFor,
    votesToday, accusedMe, defendedPartner,
  };
}

const susp = (a: Analysis, seat: Seat): number => a.suspicion.get(seat) ?? 0;
const nameOf = (view: View, seat: Seat): string =>
  view.players.find((p) => p.seat === seat)?.name ?? `seat ${seat}`;

// ---------------------------------------------------------------------------
// Reasons: a short, log-grounded reason to name in a statement.
// ---------------------------------------------------------------------------

function reasonFor(a: Analysis, view: View, target: Seat): string {
  const name = nameOf(view, target);
  for (const acc of a.accusations) {
    if (acc.from === target && acc.kind === 'accuse') {
      const victim = acc.target;
      const r = a.dead.get(victim);
      if (r && r !== 'werewolf') {
        return `they pushed ${nameOf(view, victim)} hard, and ${nameOf(view, victim)} turned out to be a ${r}`;
      }
    }
    if (acc.from === target && acc.kind === 'defend') {
      const defended = acc.target;
      if (a.dead.get(defended) === 'werewolf') {
        return `they defended ${nameOf(view, defended)}, who turned out to be a wolf`;
      }
    }
  }
  // Voted a revealed villager out.
  for (const [seat, voters] of a.votesFor) {
    if (voters.includes(target) && a.dead.get(seat) && a.dead.get(seat) !== 'werewolf') {
      return `they voted to exile ${nameOf(view, seat)}, who was a ${a.dead.get(seat)}`;
    }
  }
  if ((a.passes.get(target) ?? 0) >= 2) return 'they keep passing instead of saying anything';
  if ((a.speeches.get(target) ?? 0) === 0 && (a.passes.get(target) ?? 0) >= 1) return 'they have said nothing useful all game';
  if (a.seerClaimants.includes(target) && a.seerClaimants.length > 1) return 'their seer claim clashes with another claim';
  return 'their story does not add up and they keep dodging questions';
}

// ---------------------------------------------------------------------------
// Decisions per role. Each returns the /act body (without game/decision).
// ---------------------------------------------------------------------------

function decideKill(view: View, a: Analysis, options: Seat[], rng: () => number): { target: Seat | null } {
  // Coordinate with the partner: if the partner already voted tonight,
  // match their pick — a split kill kills nobody.
  if (a.partner !== null && view.wolfVotes) {
    const partnerVote = view.wolfVotes.find((v) => v.night === view.day && v.seat === a.partner);
    if (partnerVote && partnerVote.target !== null && options.includes(partnerVote.target)) {
      return { target: partnerVote.target };
    }
  }
  // Otherwise pick the most dangerous villager: a claimed seer first, then
  // vocal leaders, then seats pushing on the partner; spare the most
  // suspicious villagers — the village may exile them itself.
  const value = (seat: Seat): number => {
    let v = 0;
    if (a.seerClaimants.includes(seat)) v += 10;
    v += 0.7 * (a.speeches.get(seat) ?? 0);
    if (a.defendedPartner.includes(seat)) v += 2;
    if (a.knownVillagers.has(seat)) v += 1;
    v -= susp(a, seat);
    return v;
  };
  const pick = bestBy(options, value, rng);
  return { target: pick };
}

function decideProtect(view: View, a: Analysis, options: Seat[], rng: () => number): { target: Seat | null } {
  // Protect the revealed seer first, else the most valuable villager: a
  // vocal leader who has been pushing on wolves. Never ourselves and never
  // the seat protected last night (the env's options already enforce both;
  // the last-protect exclusion is repeated here as a guard).
  const last = view.lastProtect?.seat;
  const pool = last === undefined ? options : options.filter((s) => s !== last);
  if (pool.length === 0) return { target: null };
  const value = (seat: Seat): number => {
    let v = 0;
    if (a.seerClaimants.includes(seat) && seat !== a.me) v += 12;
    v += 0.5 * (a.speeches.get(seat) ?? 0);
    if (a.knownVillagers.has(seat)) v += 1.5;
    v -= 0.3 * susp(a, seat);
    return v;
  };
  const pick = bestBy(pool, value, rng);
  return { target: pick };
}

function decideInspect(view: View, a: Analysis, options: Seat[], rng: () => number): { target: Seat | null } {
  // Inspect the most suspicious living seat we do not already know.
  const unknown = options.filter((s) => !a.knownWolves.has(s) && !a.knownVillagers.has(s));
  const pool = unknown.length > 0 ? unknown : [];
  if (pool.length === 0) return { target: null };
  const pick = bestBy(pool, (s) => susp(a, s) + 0.5 * (a.speeches.get(s) ?? 0), rng);
  return { target: pick };
}

function decideVote(view: View, a: Analysis, options: Seat[], rng: () => number): { target: Seat | null } {
  if (a.role === 'werewolf') {
    // Never vote the partner. If the partner is already the plurality
    // target, vote the runner-up instead of piling on; otherwise join the
    // plurality against a villager (bandwagon: standing out gets wolves
    // caught), preferring our accusation target.
    const counts = a.votesToday;
    const nonWolf = options.filter((s) => s !== a.partner);
    if (nonWolf.length === 0) return { target: null };
    const partnerVotes = a.partner !== null ? (counts.get(a.partner) ?? 0) : 0;
    const leader = bestBy(nonWolf, (s) => (counts.get(s) ?? 0) * 2 + susp(a, s), rng);
    if (partnerVotes > 0 && leader !== null && (counts.get(leader) ?? 0) <= partnerVotes) {
      // Partner is leading the vote: back the next-best alternative.
      const alt = bestBy(nonWolf.filter((s) => s !== leader), (s) => (counts.get(s) ?? 0) * 2 + susp(a, s), rng);
      if (alt !== null) return { target: alt };
    }
    return { target: leader };
  }
  // Village side: a known wolf is always the vote. Otherwise the most
  // suspicious living seat; with no signal at all, abstain.
  const wolvesAlive = options.filter((s) => a.knownWolves.has(s));
  if (wolvesAlive.length > 0) {
    return { target: bestBy(wolvesAlive, (s) => susp(a, s), rng) };
  }
  const top = bestBy(options, (s) => susp(a, s), rng);
  if (top === null || susp(a, top) < 0.5) return { target: null };
  return { target: top };
}

function decideSpeak(view: View, a: Analysis, p: Pending, rng: () => number): { text: string } | { pass: true } {
  const max = p.max_chars ?? 500;
  const round = currentSpeakRound(view);
  const text = speakText(view, a, round, rng);
  if (text === null) return { pass: true };
  const folded = foldStatement(text);
  if (folded === '') return { pass: true };
  const cut = [...folded].length > max ? [...folded].slice(0, max).join('').trim() : folded;
  if (cut === '') return { pass: true };
  return { text: cut };
}

/** Which debate round this speak turn is: count my earlier speeches today. */
function currentSpeakRound(view: View): number {
  let n = 0;
  for (const e of view.log) {
    if (e.kind === 'speech' && e.day === view.day && e.seat === view.you.seat) n += 1;
    if (e.kind === 'pass' && e.day === view.day && e.seat === view.you.seat) n += 1;
  }
  return n + 1;
}

function speakText(view: View, a: Analysis, round: number, rng: () => number): string | null {
  const me = a.me;
  const aliveOthers = a.alive.filter((s) => s !== me);
  if (aliveOthers.length === 0) return null;

  if (a.role === 'werewolf') {
    // Accused by someone this round? Deflect onto the accuser's weak case.
    if (a.accusedMe.length > 0 && round === 2) {
      const accuser = a.accusedMe[a.accusedMe.length - 1]!;
      return `I don't buy the case on me from ${nameOf(view, accuser)} — no evidence, just a feeling. Look at the votes instead.`;
    }
    // Partner accused? Cast doubt on the case, lightly.
    if (a.partner !== null && a.accusedMe.length === 0) {
      const partnerAccused = a.accusations.some((x) => x.target === a.partner && x.kind === 'accuse');
      if (partnerAccused && round === 2) {
        return `The case on ${nameOf(view, a.partner)} is thin — one vote and a hunch. We should not exile on that.`;
      }
    }
    const target = bestBy(
      aliveOthers.filter((s) => s !== a.partner),
      (s) => susp(a, s),
      rng,
    );
    if (target === null) return null;
    if (round === 1) {
      return `I'm suspicious of ${nameOf(view, target)}: ${reasonFor(a, view, target)}. I think we should look at them today.`;
    }
    return `Still on ${nameOf(view, target)} — ${reasonFor(a, view, target)}. Voting there unless someone shows me better.`;
  }

  if (a.role === 'seer') {
    const found = view.seerResults?.find((r) => r.werewolf && a.alive.includes(r.seat));
    if (found) {
      // Reveal: a confirmed wolf is worth the target it paints.
      return `I'm the seer. I checked ${nameOf(view, found.seat)} last night: wolf. Vote ${nameOf(view, found.seat)} today.`;
    }
    // A false seer claim that contradicts my results outs a liar.
    for (const c of a.seerClaimants) {
      if (c === me) continue;
      const cleared = view.seerResults?.find((r) => !r.werewolf && a.alive.includes(r.seat));
      const accused = a.accusations.find((x) => x.from === c && x.kind === 'accuse');
      if (cleared && accused && accused.target === cleared.seat) {
        return `I'm the real seer. I checked ${nameOf(view, cleared.seat)}: villager, so ${nameOf(view, c)} is lying about being seer.`;
      }
    }
    const target = bestBy(aliveOthers, (s) => susp(a, s), rng);
    if (target === null) return null;
    if (round === 1) {
      return `I think ${nameOf(view, target)} is the one to look at: ${reasonFor(a, view, target)}.`;
    }
    return `Sticking with ${nameOf(view, target)} — ${reasonFor(a, view, target)}.`;
  }

  // Doctor and villager speak alike: the doctor never claims the role
  // (it cannot protect itself), and both push the best deduction.
  const wolvesAlive = aliveOthers.filter((s) => a.knownWolves.has(s));
  if (wolvesAlive.length > 0) {
    const w = wolvesAlive[0]!;
    if (a.role === 'doctor' && a.seerClaimants.length > 0) {
      return `The seer's check lines up: ${nameOf(view, w)} is a wolf. Vote ${nameOf(view, w)}.`;
    }
    return `${nameOf(view, w)} is a wolf — vote them out today.`;
  }
  // Back a revealed seer's accusation.
  const seer = a.seerClaimants.find((s) => s !== me && a.alive.includes(s));
  if (seer !== undefined) {
    const acc = a.accusations.find((x) => x.from === seer && x.kind === 'accuse' && a.alive.includes(x.target));
    if (acc) {
      return `I believe ${nameOf(view, seer)}'s case on ${nameOf(view, acc.target)}: ${reasonFor(a, view, acc.target)}.`;
    }
  }
  const target = bestBy(aliveOthers, (s) => susp(a, s), rng);
  if (target === null || susp(a, target) < 0.5) {
    if (round === 2) return null; // nothing new to add: pass
    return `No strong read yet. Watching the votes — whoever pushed the last exile hardest should explain themselves.`;
  }
  if (round === 1) {
    return `I'm suspicious of ${nameOf(view, target)}: ${reasonFor(a, view, target)}. I think we should look at them today.`;
  }
  return `Still on ${nameOf(view, target)} — ${reasonFor(a, view, target)}. Voting there unless someone shows me better.`;
}

// ---------------------------------------------------------------------------
// Run loop: one request at a time, in the order /observe lists them.
// ---------------------------------------------------------------------------

export interface RunSummary {
  decisions: number;
  fallbacks: number;
}

export async function run(o: { envUrl?: string; brief?: string; log?: (line: string) => void } = {}): Promise<RunSummary> {
  const env = process.env;
  const envUrl = (o.envUrl ?? env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  const seed = env.MAKEFUN_TRIAL_SEED ?? '';
  const log = o.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  if (envUrl === '') throw new Error('MAKEFUN_ENV_URL is needed');
  if (o.brief === undefined) {
    const file = env.MAKEFUN_PROMPT_FILE ?? '';
    if (file === '') throw new Error('MAKEFUN_PROMPT_FILE is needed');
    // The brief is read for completeness (the rules live in it); the
    // strategy itself needs nothing from it.
    readFileSync(file, 'utf8');
  }

  const summary: RunSummary = { decisions: 0, fallbacks: 0 };
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  interface Reply {
    status: number;
    body: unknown;
  }
  const envPost = async (path: string, body: unknown): Promise<Reply> => {
    const res = await fetch(`${envUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  };

  /** One decision, answered deterministically; a refusal falls back to a valid action. */
  const decide = async (p: Pending): Promise<void> => {
    summary.decisions += 1;
    const a = analyze(p.view);
    const rng = rngFor(seed, p.game, `${p.decision}:${p.view.day}:${p.view.log.length}`);
    const fallback: Record<string, unknown> =
      p.decision === 'speak'
        ? { game: p.game, decision: 'speak', pass: true }
        : { game: p.game, decision: p.decision, target: null };
    let act: Record<string, unknown>;
    // Guard: never name a dead seat, even if the options list it.
    const aliveOptions = (p.options ?? []).filter((s) =>
      p.view.players.find((pl) => pl.seat === s)?.alive,
    );
    const options = aliveOptions.length > 0 ? aliveOptions : (p.options ?? []);
    try {
      switch (p.decision) {
        case 'speak': {
          const s = decideSpeak(p.view, a, p, rng);
          act = 'pass' in s ? { game: p.game, decision: 'speak', pass: true } : { game: p.game, decision: 'speak', text: s.text };
          break;
        }
        case 'vote':
          act = { game: p.game, decision: 'vote', ...decideVote(p.view, a, options, rng) };
          break;
        case 'kill':
          act = { game: p.game, decision: 'kill', ...decideKill(p.view, a, options, rng) };
          break;
        case 'protect':
          act = { game: p.game, decision: 'protect', ...decideProtect(p.view, a, options, rng) };
          break;
        case 'inspect':
          act = { game: p.game, decision: 'inspect', ...decideInspect(p.view, a, options, rng) };
          break;
      }
    } catch {
      act = fallback;
    }
    // A target outside the options is refused: fall back to abstaining.
    if (act['target'] !== undefined && act['target'] !== null && !options.includes(act['target'] as Seat)) {
      act = fallback;
    }
    let posted = await envPost('/act', act);
    if (posted.status !== 200) {
      // Refused (400 bad_request / bad_target / empty / too_long, or 409
      // not_pending): nothing changed, so send the valid fallback instead.
      summary.fallbacks += 1;
      if (JSON.stringify(act) !== JSON.stringify(fallback)) {
        posted = await envPost('/act', fallback);
      }
      if (posted.status !== 200) {
        // The decision moved on (or the game ended) between /observe and
        // /act: nothing more to do for it.
        summary.fallbacks += 1;
      }
    }
  };

  for (;;) {
    let r: Reply | null = null;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        r = await envPost('/observe', {});
        if (r.status === 200 && isRecord(r.body)) break;
        r = null;
      } catch {
        r = null;
      }
      await sleep(1000); // a wait changes when a request goes, never what it is
    }
    if (r === null || !isRecord(r.body)) throw new Error('POST /observe failed repeatedly');
    const obs = r.body as unknown as Observed;
    if (obs.done) break;
    // Answer pending decisions one at a time, in the order listed.
    for (const p of obs.pending) {
      await decide(p);
    }
    if (obs.pending.length === 0) await sleep(250);
  }
  log(`werewolf-agent: ${summary.decisions} decisions, ${summary.fallbacks} fallbacks`);
  return summary;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    await run();
    process.exitCode = 0;
  } catch (err) {
    process.stderr.write(`werewolf-agent: ${(err as Error).stack ?? String(err)}\n`);
    process.exitCode = 1;
  }
}
