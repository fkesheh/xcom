/**
 * Enemy utility AI.
 *
 * The AI is decoupled from the reducer: it never imports battle.ts and never
 * mutates state directly. It reads the world through the pure helpers
 * (los / pathfinding / combat) and acts only through the {@link AiExecutor}
 * handed in, which performs the actual TU spend, reaction fire, and event
 * emission. After each exec call the AI re-reads unit state fresh from `state`,
 * since exec mutates it.
 *
 * Two movement modes keep the aliens tactically smart without freezing the
 * battles into standoffs:
 *  - Advance (default): close on the nearest player along the cheapest path,
 *    stopping at a firing position, exactly like a pressing aggressor. This is
 *    the common case and keeps engagements decisive.
 *  - Reposition (survival): when the direct advance would step into a tile that
 *    gets the unit one-shot by reaction fire, or when the unit is critically
 *    wounded and exposed, the AI instead searches every safely-reachable tile
 *    (a bounded Dijkstra that prunes lethal overwatch tiles) for the best cover
 *    / flank / line-of-sight break. Grenades are never lobbed onto a tile that
 *    would catch the thrower itself in the blast.
 *
 * Determinism: enemy ids are iterated in a fixed (sorted) order, the move
 * searches are deterministic (Dijkstra ties by cell index; path ties by TU
 * spent then (y,x)), and every tie is broken deterministically; the only
 * randomness is whatever state.rng the executor consumes.
 *
 * Purity: no DOM / three.js imports.
 */

import type {
  AiExecutor,
  BattleState,
  GameEvent,
  PsiKind,
  ShotMode,
  Unit,
  UnitId,
  Vec2,
  Weapon,
} from "./types";
import { COVER, PSI, STANCE, TU_COST } from "./types";
import { canSee, hasLineOfSight } from "./los";
import { findPath } from "./pathfinding";
import { inBounds, moveCost, tileTypeAt } from "./grid";
import {
  coverDefenseFor,
  findMode,
  hitChance,
  previewShot,
  reloadTuCost,
  tileDistance,
  tuCostForMode,
} from "./combat";
import { ITEMS } from "./content";

/** Hard cap on action iterations per unit, to guarantee termination. */
const MAX_ACTIONS_PER_UNIT = 6;
/** A unit at or below this fraction of max HP plays for survival over aggression. */
const LOW_HP_FRACTION = 0.25;

interface ShotPlan {
  target: Unit;
  mode: ShotMode;
  score: number;
}

interface PathCandidate {
  tile: Vec2;
  cum: number;
  score: number;
}

interface Reachable {
  tile: Vec2;
  /** Cumulative TU cost to enter this tile from the unit's current position. */
  cost: number;
}

interface SmartCandidate {
  tile: Vec2;
  cost: number;
  score: number;
}

interface MoveCtx {
  /** Nearest visible player: the reference for cover / line-of-sight breaking. */
  nearestVis: Unit | undefined;
  /** Visible players carrying a grenade (avoid clustering in their blast). */
  grenadeCarriers: Unit[];
}

/** Chebyshev (8-way) tile distance. */
function chebyshev(a: Vec2, b: Vec2): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** TU to enter `to` from the adjacent `from` (mirrors pathfinding's rule). */
function stepCost(state: BattleState, from: Vec2, to: Vec2): number {
  const diagonal = from.x !== to.x && from.y !== to.y;
  const base = moveCost(state.grid, to.x, to.y);
  return diagonal ? Math.floor(base * TU_COST.DIAGONAL_MULT) : base;
}

/** Reaction initiative: the reactions stat scaled by the current TU fraction. */
function reactionScoreOf(unit: Unit, tu: number): number {
  const maxTu = unit.stats.timeUnits;
  return maxTu > 0 ? unit.stats.reactions * (tu / maxTu) : 0;
}

/** Whether a unit is critically wounded and should prioritise survival. */
function isLowHp(unit: Unit): boolean {
  return unit.hp <= Math.max(1, unit.stats.health * LOW_HP_FRACTION);
}

/** Living players, sorted nearest-first with a deterministic id tie-break. */
function playersByProximity(state: BattleState, from: Vec2): Unit[] {
  const players = state.units.filter((u) => u.faction === "player" && u.alive && !u.unconscious);
  players.sort((a, b) => {
    const da = tileDistance(from, a.pos);
    const db = tileDistance(from, b.pos);
    if (da !== db) return da - db;
    return a.id - b.id;
  });
  return players;
}

/**
 * Expected reaction-fire damage `unit` would take ending at `pos` with `tuAtPos`
 * TU remaining, from the single most-dangerous player who would interrupt it.
 * Mirrors the eligibility rule in reaction.ts: a player reacts when it can see
 * the unit, can afford a snap, has ammo, and strictly out-scores the unit on
 * initiative. Reaction fire resolves one reactor at a time (highest score
 * first), so the dominant threat is the strongest reactor; counting only it
 * keeps the AI from being paralysed by every overlapping overwatch cone while
 * still flagging the clear one-shot kill tiles. Damage uses hitChance with the
 * mover's cover + kneel-target defense at `pos` (mirroring combat.totalDefenseFor
 * / resolveShot, including the 0.8 cap), so this predicts what the unit would
 * actually take -- a survivable covered tile is never misjudged as lethal, which
 * lets a wounded alien retreat into cover under overwatch. Pure: no rng, no
 * mutation.
 */
function reactionDangerAt(
  state: BattleState,
  unit: Unit,
  pos: Vec2,
  tuAtPos: number,
): number {
  const moverScore = reactionScoreOf(unit, tuAtPos);
  let worst = 0;
  const players = state.units
    .filter((u) => u.faction === "player" && u.alive && !u.unconscious)
    .sort((a, b) => a.id - b.id);
  for (const p of players) {
    const weapon = state.weapons[p.weaponId];
    if (!weapon) continue;
    const snap = findMode(weapon, "snap");
    if (!snap) continue;
    if (p.ammo < snap.shots) continue;
    if (p.tu < tuCostForMode(p, snap)) continue;
    if (!canSee(state.grid, p, pos, state.smokeClouds)) continue;
    if (!(reactionScoreOf(p, p.tu) > moverScore)) continue;
    // Mover's defense at `pos`: directional cover plus the kneel-target profile
    // bonus, capped at 0.8 -- exactly what resolveShot applies via
    // totalDefenseFor, so the prediction matches the real reaction resolver.
    const cover = coverDefenseFor(state.grid, pos, p.pos);
    const coverDefense =
      cover === 2 ? COVER.FULL_DEFENSE : cover === 1 ? COVER.HALF_DEFENSE : 0;
    const stanceDefense = unit.stance === "kneel" ? STANCE.KNEEL_TARGET_DEFENSE : 0;
    const defense = Math.min(0.8, coverDefense + stanceDefense);
    const dmg = hitChance(p, weapon, snap, tileDistance(pos, p.pos), defense) * weapon.damage;
    if (dmg > worst) worst = dmg;
  }
  return worst;
}

/** Living players the unit can currently see, nearest first. */
function visiblePlayers(state: BattleState, unit: Unit): Unit[] {
  return state.units
    .filter(
      (t) => t.faction === "player" && t.alive && !t.unconscious && canSee(state.grid, unit, t.pos),
    )
    .sort((a, b) => {
      const da = tileDistance(unit.pos, a.pos);
      const db = tileDistance(unit.pos, b.pos);
      if (da !== db) return da - db;
      return a.id - b.id;
    });
}

// ---------------------------------------------------------------------------
// Shooting, reloading, grenades
// ---------------------------------------------------------------------------

/**
 * Choose the best affordable shot at any visible target, or null. Utility is
 * expected damage (hitChance * shots * base damage), with a large bonus when the
 * shot is likely lethal and a small nudge toward weaker targets.
 */
function chooseShot(state: BattleState, unit: Unit, visible: Unit[]): ShotPlan | null {
  const weapon = state.weapons[unit.weaponId];
  if (!weapon) return null;

  let best: ShotPlan | null = null;
  const targets = [...visible].sort((a, b) => a.id - b.id);
  for (const target of targets) {
    for (const mode of weapon.modes) {
      const preview = previewShot(state, unit, target.pos, mode.kind);
      if (!preview.possible) continue;
      const expectedDamage = preview.expectedHits * weapon.damage;
      let score = expectedDamage;
      if (expectedDamage >= target.hp) score += 1000; // likely kill
      score += 1 / (1 + target.hp); // prefer weaker targets
      if (best === null || score > best.score) {
        best = { target, mode, score };
      }
    }
  }
  return best;
}

function tryReload(
  state: BattleState,
  unit: Unit,
  exec: AiExecutor,
  events: GameEvent[],
): boolean {
  const weapon = state.weapons[unit.weaponId];
  if (!weapon || unit.ammo >= weapon.magazineSize) return false;
  if (unit.tu < reloadTuCost(unit, weapon)) return false;

  const ammoBefore = unit.ammo;
  const tuBefore = unit.tu;
  events.push(...exec.reload(unit.id));
  const after = state.units.find((u) => u.id === unit.id);
  return !!after && (after.ammo > ammoBefore || after.tu < tuBefore);
}

// ---------------------------------------------------------------------------
// Psionics
// ---------------------------------------------------------------------------

/**
 * Pick the highest-value psionic target visible to and in range of `unit`:
 * prefer low psiStrength (easy to crack) then low HP (nearly dead), tie-broken
 * by ascending id. Skips units already fighting for the caster's side (e.g. one
 * it already seized this battle) so psi is never wasted.
 */
function choosePsiTarget(state: BattleState, unit: Unit): Unit | undefined {
  const targets = state.units.filter(
    (t) =>
      t.alive &&
      !t.unconscious &&
      t.faction !== unit.faction &&
      t.controlledByFaction === undefined &&
      canSee(state.grid, unit, t.pos) &&
      chebyshev(unit.pos, t.pos) <= PSI.RANGE,
  );
  targets.sort((a, b) => {
    const sa = a.stats.psiStrength ?? 0;
    const sb = b.stats.psiStrength ?? 0;
    if (sa !== sb) return sa - sb;
    if (a.hp !== b.hp) return a.hp - b.hp;
    return a.id - b.id;
  });
  return targets[0];
}

/**
 * A psi-capable unit (the commander) casts one psi attack when it has a viable
 * target and enough TU: mind control when the per-battle hard cap still allows
 * it, otherwise a panic. Returns true when a psi action was actually performed
 * (advancing the rng), so the caller can mark the unit as having used psi this
 * turn. Pure apart from the exec it drives (which mutates state + emits events).
 */
function tryPsi(
  state: BattleState,
  unit: Unit,
  exec: AiExecutor,
  events: GameEvent[],
): boolean {
  if (!exec.psiAttack) return false;
  if ((unit.stats.psiSkill ?? 0) <= 0) return false;
  if (unit.controlledByFaction !== undefined) return false;
  const target = choosePsiTarget(state, unit);
  if (!target) return false;
  const cost = Math.ceil((unit.stats.timeUnits * PSI.TU_PERCENT) / 100);
  if (unit.tu < cost) return false;

  const kind: PsiKind =
    (state.mcUsedThisBattle ?? 0) < PSI.MC_MAX_PER_BATTLE ? "mindControl" : "panic";
  const before = state.rng.state;
  const psiEvents = exec.psiAttack(unit.id, target.id, kind);
  events.push(...psiEvents);
  return psiEvents.length > 0 && state.rng.state !== before;
}

/**
 * Choose the best tile to lob a grenade at, or null. A throw is worth making
 * only when at least two living players fall inside the blast, and the THROWER
 * must end safe: no candidate whose blast would catch the thrower itself is
 * allowed, so the alien never suicides its own grenade. (Catching an ally is
 * permitted when it is the only way to hit a cluster -- a worthwhile trade --
 * which preserves the classic aggressive grenade tempo.) Candidate tiles are
 * each visible player's own tile plus every neighbour; we score by how many
 * players a blast there would catch and keep the best tile within throw range,
 * breaking ties deterministically (lowest y, then x).
 */
function chooseGrenadeThrow(
  state: BattleState,
  unit: Unit,
  visiblePlayers: Unit[],
): Vec2 | null {
  const grenadeDef = state.items?.["grenade"] ?? ITEMS.grenade;
  if (!grenadeDef) return null;
  const instance = unit.items?.find((it) => it.itemId === "grenade" && it.uses > 0);
  if (!instance) return null;

  const radius = grenadeDef.blastRadius ?? 2;
  const maxRange = grenadeDef.throwRange ?? 6;
  const livingPlayers = state.units.filter(
    (u) => u.faction === "player" && u.alive && !u.unconscious,
  );

  const candidates: Vec2[] = [];
  for (const p of visiblePlayers) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        candidates.push({ x: p.pos.x + dx, y: p.pos.y + dy });
      }
    }
  }

  let best: { tile: Vec2; covered: number } | null = null;
  for (const tile of candidates) {
    if (!inBounds(state.grid, tile.x, tile.y)) continue;
    if (chebyshev(unit.pos, tile) > maxRange) continue;

    let covered = 0;
    for (const p of livingPlayers) {
      if (chebyshev(p.pos, tile) <= radius) covered++;
    }
    if (covered < 2) continue;

    // Safety: never lob onto a tile that would catch the thrower itself.
    if (chebyshev(unit.pos, tile) <= radius) continue;

    if (
      best === null ||
      covered > best.covered ||
      (covered === best.covered &&
        (tile.y < best.tile.y || (tile.y === best.tile.y && tile.x < best.tile.x)))
    ) {
      best = { tile: { x: tile.x, y: tile.y }, covered };
    }
  }

  return best?.tile ?? null;
}

// ---------------------------------------------------------------------------
// Movement: default advance + survival repositioning
// ---------------------------------------------------------------------------

/** Score a path tile: prefer firing positions, then cover, then closeness. */
function scorePathTile(
  state: BattleState,
  tile: Vec2,
  target: Unit,
  weapon: Weapon | undefined,
): number {
  let score = 0;
  const d = tileDistance(tile, target.pos);
  if (weapon && d <= weapon.range && hasLineOfSight(state.grid, tile, target.pos)) {
    score += 1000; // can open fire from here
  }
  const tt = tileTypeAt(state.grid, tile.x, tile.y);
  if (tt && tt.cover > 0) score += 10; // cover tile
  score += 1 / (1 + d); // closer is better
  return score;
}

/** Deterministic best path candidate within `budget`: score, progress, x, y. */
function pickPath(candidates: PathCandidate[], budget: number): PathCandidate | null {
  let best: PathCandidate | null = null;
  for (const c of candidates) {
    if (c.cum > budget) continue;
    if (best === null) {
      best = c;
      continue;
    }
    if (
      c.score > best.score ||
      (c.score === best.score && c.cum > best.cum) ||
      (c.score === best.score && c.cum === best.cum && c.tile.x < best.tile.x) ||
      (c.score === best.score &&
        c.cum === best.cum &&
        c.tile.x === best.tile.x &&
        c.tile.y < best.tile.y)
    ) {
      best = c;
    }
  }
  return best;
}

/**
 * Default advance: close on the nearest visible (else known) player along the
 * cheapest path, preferring firing positions and cover, and keeping a snap in
 * reserve when possible. Returns the destination to move to, or null when no
 * progress is possible. Mirrors the classic pressing aggressor.
 */
/**
 * Every tile reachable from `unit.pos` within its TU budget, EXCLUDING tiles that
 * are lethal to step into or onto (reaction danger >= current HP), so a unit
 * repositioning under fire never paths through or into an overwatch kill-zone. A
 * bounded Dijkstra over the same move graph as pathfinding.ts (orthogonal
 * moveCost, diagonal x1.5, no corner-cutting). Deterministic: ties resolve by
 * lowest cell index.
 */
function safeReachableTiles(
  state: BattleState,
  unit: Unit,
  isBlocked: (x: number, y: number) => boolean,
): Reachable[] {
  const grid = state.grid;
  const w = grid.width;
  const n = w * grid.height;
  const g = new Float64Array(n).fill(Infinity);
  const done = new Uint8Array(n);
  const startIdx = unit.pos.y * w + unit.pos.x;
  g[startIdx] = 0;

  const dirs: ReadonlyArray<readonly [number, number]> = [
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
  ];

  const out: Reachable[] = [];
  const budget = unit.tu;
  const hp = unit.hp;

  for (;;) {
    let u = -1;
    let ug = Infinity;
    for (let i = 0; i < n; i++) {
      if (done[i]) continue;
      const gi = g[i] ?? Infinity;
      if (gi < ug) {
        ug = gi;
        u = i;
      }
    }
    if (u === -1 || ug > budget) break;
    done[u] = 1;
    if (u !== startIdx) {
      out.push({ tile: { x: u % w, y: Math.floor(u / w) }, cost: ug });
    }
    const ux = u % w;
    const uy = (u - ux) / w;
    const ug0 = g[u] ?? Infinity;
    for (const [dx, dy] of dirs) {
      const nx = ux + dx;
      const ny = uy + dy;
      if (!inBounds(grid, nx, ny)) continue;
      if (moveCost(grid, nx, ny) === Infinity) continue;
      if (isBlocked(nx, ny)) continue;
      const diagonal = dx !== 0 && dy !== 0;
      if (diagonal) {
        if (
          moveCost(grid, ux + dx, uy) === Infinity ||
          moveCost(grid, ux, uy + dy) === Infinity
        ) {
          continue; // no corner-cutting
        }
      }
      const base = moveCost(grid, nx, ny);
      const enter = diagonal ? Math.floor(base * TU_COST.DIAGONAL_MULT) : base;
      const ng = ug0 + enter;
      if (ng > budget) continue;
      const ni = ny * w + nx;
      if (ng >= (g[ni] ?? Infinity)) continue;
      // Lethal to step onto: never path through or into an overwatch kill tile.
      if (hp > 0 && reactionDangerAt(state, unit, { x: nx, y: ny }, unit.tu - ng) >= hp) {
        continue;
      }
      g[ni] = ng;
    }
  }
  return out;
}

function buildMoveCtx(state: BattleState, unit: Unit): MoveCtx {
  const visible = visiblePlayers(state, unit);
  const grenadeCarriers = visible.filter((p) =>
    (p.items ?? []).some((it) => it.itemId === "grenade" && it.uses > 0),
  );
  return { nearestVis: visible[0], grenadeCarriers };
}

/**
 * Score a repositioning tile for survival: cover from the nearest visible
 * player, breaking line of sight, opening the range when wounded, a small
 * preference for keeping a snap in reserve, and avoiding grenade-killable
 * clusters. Pure: no rng. (Reaction danger is handled as a hard exclude in
 * safeReachableTiles; sub-lethal exposure is intentionally not penalised so the
 * aliens still press an attack through trading fire.)
 */
function scoreSmartTile(
  state: BattleState,
  unit: Unit,
  tile: Vec2,
  cost: number,
  ctx: MoveCtx,
): number {
  const weapon = state.weapons[unit.weaponId];
  const tuAtDest = unit.tu - cost;
  let score = 0;

  if (weapon) {
    const snap = findMode(weapon, "snap");
    if (snap && tuAtDest >= tuCostForMode(unit, snap)) score += 8; // keep a snap in reserve
  }

  if (ctx.nearestVis) {
    const threat = ctx.nearestVis;
    score += coverDefenseFor(state.grid, tile, threat.pos) * 120; // cover
    const d = tileDistance(tile, threat.pos);
    if (isLowHp(unit)) {
      // Wounded: open the range and break line of sight.
      score += d * 4;
      if (!hasLineOfSight(state.grid, tile, threat.pos)) score += 300;
    } else {
      // Still press in when healthy enough to fight.
      score += 120 / (1 + d);
    }
  }

  const grenadeRadius = (state.items?.["grenade"] ?? ITEMS.grenade)?.blastRadius ?? 2;
  for (const carrier of ctx.grenadeCarriers) {
    if (chebyshev(tile, carrier.pos) <= grenadeRadius) score -= 100;
  }
  return score;
}

/** Deterministic best smart candidate within `budget`: score, then (y,x). */
function pickSmart(candidates: SmartCandidate[], budget: number): SmartCandidate | null {
  let best: SmartCandidate | null = null;
  for (const c of candidates) {
    if (c.cost > budget) continue;
    if (best === null) {
      best = c;
      continue;
    }
    if (
      c.score > best.score ||
      (c.score === best.score &&
        (c.tile.y < best.tile.y || (c.tile.y === best.tile.y && c.tile.x < best.tile.x)))
    ) {
      best = c;
    }
  }
  return best;
}

/**
 * Survival repositioning: used when the direct advance would walk into an
 * overwatch kill-tile, or when a critically-wounded alien breaks for safety.
 * Searches every safely-reachable tile and relocates only when one strictly
 * beats holding the current position. Returns true when a move was issued and
 * the unit actually relocated.
 */
function tryReposition(
  state: BattleState,
  unit: Unit,
  exec: AiExecutor,
  events: GameEvent[],
): boolean {
  const isBlocked = (x: number, y: number): boolean =>
    state.units.some(
      (o) => o.alive && o.id !== unit.id && o.pos.x === x && o.pos.y === y,
    );

  const reachable = safeReachableTiles(state, unit, isBlocked);
  const ctx = buildMoveCtx(state, unit);
  const candidates: SmartCandidate[] = reachable.map((r) => ({
    tile: r.tile,
    cost: r.cost,
    score: scoreSmartTile(state, unit, r.tile, r.cost, ctx),
  }));

  const holdScore = scoreSmartTile(state, unit, unit.pos, 0, ctx);

  const weapon = state.weapons[unit.weaponId];
  const snap = weapon ? findMode(weapon, "snap") : undefined;
  const reserve = snap ? tuCostForMode(unit, snap) : 0;

  let chosen = pickSmart(candidates, Math.max(0, unit.tu - reserve));
  if (!chosen) chosen = pickSmart(candidates, unit.tu);
  if (!chosen || chosen.score <= holdScore) return false;

  const before: Vec2 = { x: unit.pos.x, y: unit.pos.y };
  events.push(...exec.move(unit.id, chosen.tile));
  const after = state.units.find((u) => u.id === unit.id);
  return !!after && (after.pos.x !== before.x || after.pos.y !== before.y);
}

/**
 * Move the unit: by default advance on the nearest player along the cheapest
 * path (the classic pressing aggressor); reposition for survival when pressing
 * in would walk into an overwatch one-shot kill, or when a critically-wounded
 * alien is exposed in the open. Holds when nothing improves on staying put.
 */
function tryMove(
  state: BattleState,
  unit: Unit,
  exec: AiExecutor,
  events: GameEvent[],
): boolean {
  // Critically wounded with a threat in sight: play for survival. If exposed,
  // break for cover / line of sight; if already in cover, hold it rather than
  // advance back out into the open.
  const threat = visiblePlayers(state, unit)[0];
  if (isLowHp(unit) && threat) {
    if (coverDefenseFor(state.grid, unit.pos, threat.pos) === 0) {
      return tryReposition(state, unit, exec, events);
    }
    return false;
  }

  // Default advance: close on the nearest player along the cheapest path. This
  // mirrors the original aggressor tempo so battles stay decisive.
  const players = playersByProximity(state, unit.pos);
  const target = players[0];
  if (target) {
    const isBlocked = (x: number, y: number): boolean =>
      state.units.some(
        (o) => o.alive && o.id !== unit.id && o.pos.x === x && o.pos.y === y,
      );
    const result = findPath(state.grid, unit.pos, target.pos, { isBlocked });
    if (result && result.path.length > 0) {
      const weapon = state.weapons[unit.weaponId];
      const candidates: PathCandidate[] = [];
      let prev: Vec2 = unit.pos;
      let cum = 0;
      for (const tile of result.path) {
        cum += stepCost(state, prev, tile);
        const isTargetTile = tile.x === target.pos.x && tile.y === target.pos.y;
        if (!isTargetTile) {
          candidates.push({ tile, cum, score: scorePathTile(state, tile, target, weapon) });
        }
        prev = tile;
      }
      const snap = weapon ? findMode(weapon, "snap") : undefined;
      const reserve = snap ? tuCostForMode(unit, snap) : 0;
      let chosen = pickPath(candidates, Math.max(0, unit.tu - reserve));
      if (!chosen) chosen = pickPath(candidates, unit.tu);
      if (chosen) {
        // No suicide: refuse to step onto an overwatch one-shot kill tile.
        const danger = reactionDangerAt(state, unit, chosen.tile, unit.tu - chosen.cum);
        if (unit.hp > 0 && danger >= unit.hp) {
          return tryReposition(state, unit, exec, events);
        }
        const before: Vec2 = { x: unit.pos.x, y: unit.pos.y };
        events.push(...exec.move(unit.id, chosen.tile));
        const after = state.units.find((u) => u.id === unit.id);
        if (after && (after.pos.x !== before.x || after.pos.y !== before.y)) return true;
      }
    }
  }

  // No advance available: stop here (mirrors the original aggressor, which ends
  // its turn when it can't close further). Survival repositioning is reserved for
  // the explicit retreat / lethal-advance cases above.
  return false;
}

/**
 * Run the full enemy turn: each living enemy shoots a visible target when it
 * can, otherwise advances on the nearest player (repositioning for survival
 * when pressing in would get it killed). Returns every event the executor
 * produced, in order.
 */
export function runEnemyTurn(state: BattleState, exec: AiExecutor): GameEvent[] {
  const events: GameEvent[] = [];
  const enemyIds: UnitId[] = state.units
    .filter((u) => u.faction === "enemy" && u.alive && !u.unconscious)
    .map((u) => u.id)
    .sort((a, b) => a - b);
  // A psi-capable unit casts at most one psi attack per turn (the rest of its
  // TU goes to guns / movement); tracked per unit id for determinism.
  const psiedThisTurn = new Set<UnitId>();

  for (const id of enemyIds) {
    for (let iteration = 0; iteration < MAX_ACTIONS_PER_UNIT; iteration++) {
      if (state.status !== "playing") return events;

      const unit = state.units.find((u) => u.id === id);
      if (!unit || !unit.alive || unit.unconscious || unit.tu <= 0) break;

      // Psionics: a psi-capable unit (the alien commander) leads with one psi
      // attack per turn — mind control when the hard cap allows, else a panic —
      // aimed at the softest visible target, before falling through to guns.
      if (!psiedThisTurn.has(id) && tryPsi(state, unit, exec, events)) {
        psiedThisTurn.add(id);
        continue;
      }

      // Aliens hunt civilians as readily as soldiers: a terror-site strike zone
      // puts neutral civilians in the line of fire, so the shot-target pool is
      // every visible player AND civilian. chooseShot scores by expected damage
      // with a kill bonus and a nudge toward weaker targets, so low-HP civilians
      // naturally draw fire. Movement still keys off players only.
      const visible = state.units.filter(
        (t) =>
          (t.faction === "player" || t.faction === "civilian") &&
          t.alive &&
          !t.unconscious &&
          canSee(state.grid, unit, t.pos),
      );

      // Grenade: lob one when a throw catches >=2 players, ends safe, and TU allows.
      const grenadeTile = chooseGrenadeThrow(state, unit, visible);
      if (grenadeTile && exec.throwItem) {
        const grenadeDef = state.items?.["grenade"];
        const grenadeTu = grenadeDef
          ? Math.ceil((unit.stats.timeUnits * grenadeDef.tuPercent) / 100)
          : 0;
        if (unit.tu >= grenadeTu) {
          const thrown = exec.throwItem(unit.id, grenadeTile, "grenade");
          events.push(...thrown);
          if (thrown.length > 0) continue;
        }
      }

      const plan = visible.length > 0 ? chooseShot(state, unit, visible) : null;
      if (plan) {
        const tuBefore = unit.tu;
        events.push(...exec.shoot(unit.id, plan.target.pos, plan.mode.kind));
        const after = state.units.find((u) => u.id === id);
        if (!after || after.tu >= tuBefore) break; // no progress; avoid a loop
        continue;
      }

      if ((visible.length > 0 || unit.ammo === 0) && tryReload(state, unit, exec, events)) {
        continue;
      }

      if (!tryMove(state, unit, exec, events)) break;
    }
  }

  return events;
}
