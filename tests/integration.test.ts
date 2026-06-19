/**
 * End-to-end integration smoke test: auto-play a whole skirmish to a winner
 * using only the public sim API the renderer uses. Proves the full loop
 * (move -> reaction fire -> shoot -> enemy AI turn -> victory) runs without
 * crashing, terminates, holds its invariants every round, and is deterministic.
 */
import { describe, it, expect } from "vitest";
import {
  createSkirmish,
  applyCommand,
  previewPlayerShot,
  livingUnits,
  canSee,
  findPath,
  tileTypeAt,
  TU_COST,
} from "../src/sim/index";
import type { BattleState, Unit, Vec2 } from "../src/sim/types";

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function occupiedByOther(state: BattleState, selfId: number, x: number, y: number): boolean {
  for (const u of state.units) {
    if (u.alive && u.id !== selfId && u.pos.x === x && u.pos.y === y) return true;
  }
  return false;
}

function stepCost(state: BattleState, from: Vec2, to: Vec2): number {
  const tt = tileTypeAt(state.grid, to.x, to.y);
  const base = tt ? tt.moveCost : Infinity;
  const diagonal = from.x !== to.x && from.y !== to.y;
  return diagonal ? Math.floor(base * TU_COST.DIAGONAL_MULT) : base;
}

/** Furthest non-blocked, unoccupied, non-enemy tile along the path within the TU budget. */
function furthestAffordable(
  state: BattleState,
  unit: Unit,
  path: Vec2[],
  enemyPos: Vec2,
): Vec2 | undefined {
  let cost = 0;
  let prev = unit.pos;
  let best: Vec2 | undefined;
  for (const step of path) {
    cost += stepCost(state, prev, step);
    if (cost > unit.tu) break;
    prev = step;
    const isEnemyTile = step.x === enemyPos.x && step.y === enemyPos.y;
    if (!isEnemyTile && !occupiedByOther(state, unit.id, step.x, step.y)) best = { ...step };
  }
  return best;
}

function nearest(from: Vec2, units: Unit[]): Unit | undefined {
  let best: Unit | undefined;
  let bestD = Infinity;
  for (const u of units) {
    const d = dist(from, u.pos);
    if (d < bestD || (d === bestD && best && u.id < best.id)) {
      best = u;
      bestD = d;
    }
  }
  return best;
}

/** Greedy, fully-deterministic auto-player: shoot what you can, else close in. */
function takePlayerTurn(state: BattleState): void {
  for (let guard = 0; guard < 60; guard++) {
    const players = livingUnits(state, "player").filter((u) => u.tu > 0);
    const enemies = livingUnits(state, "enemy");
    if (players.length === 0 || enemies.length === 0) break;

    let acted = false;
    for (const pu of players) {
      if (pu.tu <= 0 || state.status !== "playing") continue;

      const targets = enemies
        .filter((e) => e.alive && canSee(state.grid, pu, e.pos))
        .sort((a, b) => dist(pu.pos, a.pos) - dist(pu.pos, b.pos) || a.id - b.id);

      let didShoot = false;
      for (const t of targets) {
        if (previewPlayerShot(state, pu.id, t.pos, "snap").possible) {
          applyCommand(state, { type: "shoot", unitId: pu.id, target: t.pos, mode: "snap" });
          didShoot = true;
          acted = true;
          break;
        }
      }
      if (didShoot) continue;

      const target = nearest(pu.pos, enemies);
      if (!target) continue;
      const result = findPath(state.grid, pu.pos, target.pos, {
        isBlocked: (x, y) => occupiedByOther(state, pu.id, x, y),
      });
      if (!result || result.path.length === 0) continue;
      const dest = furthestAffordable(state, pu, result.path, target.pos);
      if (!dest) continue;
      const tuBefore = pu.tu;
      applyCommand(state, { type: "move", unitId: pu.id, to: dest });
      if (pu.tu !== tuBefore) acted = true;
    }
    if (!acted) break;
  }
}

interface MatchOutcome {
  status: BattleState["status"];
  rounds: number;
  survivorHp: number[];
  totalDamageObserved: number;
}

function autoPlay(seed: number, maxRounds = 120): MatchOutcome {
  const state = createSkirmish({ seed, width: 24, height: 18, players: 4, enemies: 5 });
  const startHp = new Map<number, number>(state.units.map((u) => [u.id, u.hp]));
  let rounds = 0;

  while (state.status === "playing" && rounds < maxRounds) {
    takePlayerTurn(state);
    assertInvariants(state);
    if (state.status !== "playing") break;
    applyCommand(state, { type: "endTurn" }); // runs the enemy AI turn
    assertInvariants(state);
    rounds++;
  }

  // How much total damage was dealt across the match (proves combat actually engaged).
  let totalDamageObserved = 0;
  for (const u of state.units) {
    const s = startHp.get(u.id) ?? u.hp;
    totalDamageObserved += Math.max(0, s - u.hp);
  }

  return {
    status: state.status,
    rounds,
    survivorHp: livingUnits(state, "player")
      .concat(livingUnits(state, "enemy"))
      .map((u) => u.hp)
      .sort((a, b) => a - b),
    totalDamageObserved,
  };
}

function assertInvariants(state: BattleState): void {
  const seen = new Set<number>();
  for (const u of state.units) {
    if (!u.alive) continue;
    // TU and HP stay in range.
    expect(u.tu).toBeGreaterThanOrEqual(0);
    expect(u.hp).toBeGreaterThan(0);
    expect(u.hp).toBeLessThanOrEqual(u.stats.health);
    // Living units never stand on a blocking tile.
    const tt = tileTypeAt(state.grid, u.pos.x, u.pos.y);
    expect(tt, `unit ${u.id} off-grid at ${u.pos.x},${u.pos.y}`).toBeDefined();
    expect(tt?.blocksMove).toBe(false);
    // No two living units share a tile.
    const key = u.pos.y * state.grid.width + u.pos.x;
    expect(seen.has(key), `two living units stacked at ${u.pos.x},${u.pos.y}`).toBe(false);
    seen.add(key);
  }
}

describe("full-match integration", () => {
  it("auto-plays to a decisive winner without crashing, holding invariants", () => {
    const outcome = autoPlay(12345);
    expect(["player_win", "enemy_win"]).toContain(outcome.status);
    expect(outcome.rounds).toBeGreaterThan(0);
    expect(outcome.rounds).toBeLessThan(120);
    // Combat genuinely happened (shooting + AI engaged, not a stalemate timeout).
    expect(outcome.totalDamageObserved).toBeGreaterThan(0);
  });

  it("is deterministic: same seed => identical outcome", () => {
    const a = autoPlay(777);
    const b = autoPlay(777);
    expect(b.status).toBe(a.status);
    expect(b.rounds).toBe(a.rounds);
    expect(b.survivorHp).toEqual(a.survivorHp);
    expect(b.totalDamageObserved).toBe(a.totalDamageObserved);
  });

  it("different seeds explore different games", () => {
    const seeds = [1, 2, 3, 4, 5].map((s) => autoPlay(s));
    for (const o of seeds) expect(["player_win", "enemy_win"]).toContain(o.status);
    // Not all five seeds should collapse to the exact same script.
    const signatures = new Set(seeds.map((o) => `${o.status}:${o.rounds}:${o.totalDamageObserved}`));
    expect(signatures.size).toBeGreaterThan(1);
  });
});
