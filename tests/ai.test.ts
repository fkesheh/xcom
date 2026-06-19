import { describe, it, expect } from "vitest";
import { Rng } from "../src/sim/rng";
import { makeGrid } from "../src/sim/grid";
import { findPath } from "../src/sim/pathfinding";
import { findMode, reloadTuCost, resolveShot, tuCostForMode } from "../src/sim/combat";
import { runEnemyTurn } from "../src/sim/ai";
import type {
  AiExecutor,
  BattleState,
  Dir8,
  Faction,
  GameEvent,
  ShotKind,
  Unit,
  UnitId,
  Vec2,
  Weapon,
} from "../src/sim/types";

function makeUnit(
  id: UnitId,
  faction: Faction,
  pos: Vec2,
  facing: Dir8,
  overrides: Partial<Unit> = {},
): Unit {
  return {
    id,
    name: `u${id}`,
    templateId: "t",
    faction,
    pos,
    facing,
    stats: {
      timeUnits: 60,
      health: 30,
      reactions: 40,
      firingAccuracy: 80,
      strength: 30,
    },
    tu: 60,
    hp: 30,
    weaponId: "rifle",
    ammo: 24,
    alive: true,
    reserve: "none",
    sightRange: 20,
    visionHalfAngleDeg: 60,
    ...overrides,
  };
}

function makeWeapon(overrides: Partial<Weapon> = {}): Weapon {
  return {
    id: "rifle",
    name: "Rifle",
    damage: 20,
    range: 15,
    magazineSize: 24,
    reloadTuPercent: 20,
    modes: [
      { kind: "snap", tuPercent: 25, accuracy: 60, shots: 1 },
      { kind: "aimed", tuPercent: 50, accuracy: 110, shots: 1 },
      { kind: "auto", tuPercent: 35, accuracy: 35, shots: 3 },
    ],
    ...overrides,
  };
}

function makeState(
  units: Unit[],
  weapon: Weapon = makeWeapon(),
  seed = 555,
  width = 30,
  height = 12,
): BattleState {
  return {
    grid: makeGrid(width, height),
    units,
    weapons: { [weapon.id]: weapon },
    turn: 1,
    activeFaction: "enemy",
    rng: new Rng(seed),
    status: "playing",
    explored: new Set<number>(),
    log: [],
  };
}

/** A minimal executor that mutates state the way the real reducer would. */
function makeExec(state: BattleState): AiExecutor {
  const unitById = (id: UnitId): Unit => {
    const u = state.units.find((x) => x.id === id);
    if (!u) throw new Error(`no unit ${id}`);
    return u;
  };
  return {
    move(unitId: UnitId, to: Vec2): GameEvent[] {
      const u = unitById(unitId);
      const blocked = (x: number, y: number) =>
        state.units.some(
          (o) => o.alive && o.id !== unitId && o.pos.x === x && o.pos.y === y,
        );
      const result = findPath(state.grid, u.pos, to, {
        maxCost: u.tu,
        isBlocked: blocked,
      });
      if (!result || result.path.length === 0) return [];
      const from = { ...u.pos };
      u.pos = { x: to.x, y: to.y };
      u.tu -= result.cost;
      return [
        {
          type: "moveStep",
          unitId,
          from,
          to: { x: to.x, y: to.y },
          facing: u.facing,
          tuLeft: u.tu,
        },
      ];
    },
    shoot(unitId: UnitId, target: Vec2, mode: ShotKind): GameEvent[] {
      const u = unitById(unitId);
      const weapon = state.weapons[u.weaponId];
      if (!weapon) return [];
      const m = findMode(weapon, mode);
      if (!m) return [];
      u.tu -= tuCostForMode(u, m);
      u.ammo = Math.max(0, u.ammo - m.shots);
      const res = resolveShot(state, u, target, mode);
      return [
        {
          type: "shot",
          shooterId: unitId,
          targetId: res.targetId,
          targetPos: { x: target.x, y: target.y },
          originPos: { x: u.pos.x, y: u.pos.y },
          mode,
          rounds: res.rounds,
          tuLeft: u.tu,
          reaction: false,
        },
      ];
    },
    reload(unitId: UnitId): GameEvent[] {
      const u = unitById(unitId);
      const weapon = state.weapons[u.weaponId];
      if (!weapon) return [];
      const cost = reloadTuCost(u, weapon);
      if (u.tu < cost || u.ammo >= weapon.magazineSize) return [];
      u.tu -= cost;
      u.ammo = weapon.magazineSize;
      return [{ type: "reloaded", unitId, ammo: u.ammo, tuLeft: u.tu }];
    },
    face(unitId: UnitId, dir: Dir8): GameEvent[] {
      const u = unitById(unitId);
      u.facing = dir;
      return [{ type: "faced", unitId, dir, tuLeft: u.tu }];
    },
  };
}

describe("runEnemyTurn", () => {
  it("shoots a visible player target that is in range", () => {
    // Enemy at (10,5) facing W toward a player at (5,5): visible, in range, LOS clear.
    const enemy = makeUnit(2, "enemy", { x: 10, y: 5 }, 6 /* W */);
    const player = makeUnit(1, "player", { x: 5, y: 5 }, 2, { hp: 1000 });
    const state = makeState([enemy, player]);
    const events = runEnemyTurn(state, makeExec(state));
    const fired = events.filter((e) => e.type === "shot");
    expect(fired.length).toBeGreaterThanOrEqual(1);
    expect(fired.every((e) => e.type === "shot" && e.shooterId === 2)).toBe(true);
    expect(enemy.tu).toBeLessThan(60);
    expect(enemy.ammo).toBeLessThan(24);
  });

  it("reloads when a visible target is available but the magazine is empty", () => {
    const enemy = makeUnit(2, "enemy", { x: 10, y: 5 }, 6, { ammo: 0, tu: 12 });
    const player = makeUnit(1, "player", { x: 5, y: 5 }, 2, { hp: 1000 });
    const state = makeState([enemy, player]);
    const events = runEnemyTurn(state, makeExec(state));

    expect(events).toEqual([{ type: "reloaded", unitId: 2, ammo: 24, tuLeft: 0 }]);
    expect(enemy.ammo).toBe(24);
    expect(enemy.tu).toBe(0);
  });

  it("moves toward the nearest player when no target is visible", () => {
    // Enemy can't see the distant player (short sight range) so it advances.
    const enemy = makeUnit(2, "enemy", { x: 1, y: 5 }, 2 /* E */, {
      sightRange: 4,
    });
    const player = makeUnit(1, "player", { x: 25, y: 5 }, 6);
    const state = makeState([enemy, player]);
    const startX = enemy.pos.x;
    const events = runEnemyTurn(state, makeExec(state));
    expect(events.some((e) => e.type === "moveStep")).toBe(true);
    expect(enemy.pos.x).toBeGreaterThan(startX); // closer to the player
  });

  it("does nothing for a dead enemy and only acts through the executor", () => {
    const enemy = makeUnit(2, "enemy", { x: 10, y: 5 }, 6, { alive: false });
    const player = makeUnit(1, "player", { x: 5, y: 5 }, 2);
    const state = makeState([enemy, player]);
    expect(runEnemyTurn(state, makeExec(state))).toHaveLength(0);
  });

  it("is deterministic: identical states produce identical event streams", () => {
    const build = () => {
      const enemy = makeUnit(2, "enemy", { x: 10, y: 5 }, 6);
      const player = makeUnit(1, "player", { x: 5, y: 5 }, 2, { hp: 1000 });
      return makeState([enemy, player], makeWeapon(), 31337);
    };
    const a = build();
    const ea = runEnemyTurn(a, makeExec(a));
    const b = build();
    const eb = runEnemyTurn(b, makeExec(b));
    expect(ea).toEqual(eb);
  });

  it("stops acting once the unit runs out of TU", () => {
    const enemy = makeUnit(2, "enemy", { x: 10, y: 5 }, 6, { tu: 60 });
    const player = makeUnit(1, "player", { x: 5, y: 5 }, 2, { hp: 1000 });
    const state = makeState([enemy, player]);
    runEnemyTurn(state, makeExec(state));
    // Snap costs 15; it should never go negative.
    expect(enemy.tu).toBeGreaterThanOrEqual(0);
  });
});
