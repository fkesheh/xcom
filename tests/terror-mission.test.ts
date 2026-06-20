import { describe, it, expect } from "vitest";
import { Rng } from "../src/sim/rng";
import { makeGrid } from "../src/sim/grid";
import { findPath } from "../src/sim/pathfinding";
import { findMode, reloadTuCost, resolveShot, tuCostForMode } from "../src/sim/combat";
import { runEnemyTurn } from "../src/sim/ai";
import { createSkirmish } from "../src/sim/setup";
import { applyCommand, checkVictory, livingUnits } from "../src/sim/battle";
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

// ---------------------------------------------------------------------------
// Minimal manual-state helpers (mirror tests/ai.test.ts) for the AI case.
// ---------------------------------------------------------------------------

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
    templateId: faction === "civilian" ? "civilian" : "t",
    faction,
    pos,
    facing,
    stats: {
      timeUnits: 60,
      health: faction === "civilian" ? 8 : 30,
      reactions: 40,
      firingAccuracy: 80,
      strength: 30,
    },
    tu: 60,
    hp: faction === "civilian" ? 8 : 30,
    weaponId: faction === "civilian" ? "pistol" : "plasma",
    ammo: 8,
    alive: true,
    reserve: "none",
    sightRange: 18,
    visionHalfAngleDeg: 45,
    ...overrides,
  };
}

function plasma(): Weapon {
  return {
    id: "plasma",
    name: "Plasma",
    damage: 40,
    range: 14,
    magazineSize: 8,
    reloadTuPercent: 24,
    modes: [
      { kind: "snap", tuPercent: 30, accuracy: 50, shots: 1 },
      { kind: "aimed", tuPercent: 55, accuracy: 100, shots: 1 },
    ],
  };
}

function makeState(units: Unit[], seed = 555): BattleState {
  return {
    grid: makeGrid(30, 12),
    units,
    weapons: { plasma: plasma() },
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
    move(unitId, to) {
      const u = unitById(unitId);
      const blocked = (x: number, y: number) =>
        state.units.some((o) => o.alive && o.id !== unitId && o.pos.x === x && o.pos.y === y);
      const result = findPath(state.grid, u.pos, to, { maxCost: u.tu, isBlocked: blocked });
      if (!result || result.path.length === 0) return [];
      const from = { ...u.pos };
      u.pos = { x: to.x, y: to.y };
      u.tu -= result.cost;
      return [{ type: "moveStep", unitId, from, to: { x: to.x, y: to.y }, facing: u.facing, tuLeft: u.tu }];
    },
    shoot(unitId, target, mode: ShotKind) {
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
    reload(unitId) {
      const u = unitById(unitId);
      const weapon = state.weapons[u.weaponId];
      if (!weapon) return [];
      const cost = reloadTuCost(u, weapon);
      if (u.tu < cost || u.ammo >= weapon.magazineSize) return [];
      u.tu -= cost;
      u.ammo = weapon.magazineSize;
      return [{ type: "reloaded", unitId, ammo: u.ammo, tuLeft: u.tu }];
    },
    face(unitId, dir) {
      const u = unitById(unitId);
      u.facing = dir;
      return [{ type: "faced", unitId, dir, tuLeft: u.tu }];
    },
  };
}

// ---------------------------------------------------------------------------

describe("terror-site setup (rescue)", () => {
  it("spawns the requested civilians and a rescue objective", () => {
    const state = createSkirmish({ seed: 7, objectiveKind: "rescue", civilianCount: 6 });

    const civilians = state.units.filter((u) => u.faction === "civilian");
    expect(civilians).toHaveLength(6);
    for (const c of civilians) {
      expect(c.alive).toBe(true);
      expect(c.templateId).toBe("civilian");
      expect(c.hp).toBe(c.stats.health);
    }

    // No two units share a tile.
    const tiles = new Set(state.units.map((u) => `${u.pos.x},${u.pos.y}`));
    expect(tiles.size).toBe(state.units.length);

    expect(state.objective).toBeDefined();
    expect(state.objective).toMatchObject({
      kind: "rescue",
      label: "Protect the civilians",
      recovered: false,
      extracted: false,
      extractionZone: [],
    });
    expect(state.objective?.civiliansTotal).toBe(6);
    // The rescue marker sits on the city centre.
    expect(state.objective?.target).toEqual({ x: 15, y: 15 });
  });

  it("leaves the recover objective untouched for crash/landed missions", () => {
    const recover = createSkirmish({ seed: 7, objectiveKind: "recover" });
    expect(recover.objective?.kind).toBe("recover");
    expect(recover.objective?.label).toBe("Recover UFO power source");
    expect(recover.units.some((u) => u.faction === "civilian")).toBe(false);

    // The legacy default (no objectiveKind) is still recover and civilian-free.
    const legacy = createSkirmish({ seed: 7 });
    expect(legacy.objective?.kind).toBe("recover");
    expect(legacy.units.some((u) => u.faction === "civilian")).toBe(false);
  });

  it("treats civilians as neutral: never counted as player or enemy", () => {
    const state = createSkirmish({ seed: 7, objectiveKind: "rescue", civilianCount: 5 });

    const livingPlayers = livingUnits(state, "player");
    const livingEnemies = livingUnits(state, "enemy");
    const livingCivilians = livingUnits(state, "civilian");

    expect(livingPlayers.every((u) => u.faction === "player")).toBe(true);
    expect(livingEnemies.every((u) => u.faction === "enemy")).toBe(true);
    expect(livingCivilians.every((u) => u.faction === "civilian")).toBe(true);
    expect(livingCivilians).toHaveLength(5);
    // No civilian bleeds into the player or enemy rosters.
    expect(livingPlayers.some((u) => u.faction === "civilian")).toBe(false);
    expect(livingEnemies.some((u) => u.faction === "civilian")).toBe(false);
  });
});

describe("rescue victory conditions", () => {
  it("wins by eliminating every hostile regardless of civilian survival", () => {
    const state = createSkirmish({ seed: 11, objectiveKind: "rescue", civilianCount: 6 });
    // Kill every enemy AND every civilian: clearing the aliens still wins.
    for (const u of state.units) {
      if (u.faction === "enemy" || u.faction === "civilian") u.alive = false;
    }
    const over = checkVictory(state);
    expect(over).toEqual({ type: "gameOver", status: "player_win" });
    expect(state.status).toBe("player_win");
    // Rescue objective is not force-extracted (no recover/extraction semantics).
    expect(state.objective?.extracted).toBe(false);
  });

  it("wins when enemies are cleared even if all civilians survive", () => {
    const state = createSkirmish({ seed: 11, objectiveKind: "rescue", civilianCount: 6 });
    for (const u of state.units) {
      if (u.faction === "enemy") u.alive = false;
    }
    expect(livingUnits(state, "civilian").length).toBe(6); // all survived
    const over = checkVictory(state);
    expect(over?.type).toBe("gameOver");
    expect(state.status).toBe("player_win");
  });

  it("loses when the squad is wiped even with civilians alive", () => {
    const state = createSkirmish({ seed: 11, objectiveKind: "rescue", civilianCount: 6 });
    for (const u of state.units) {
      if (u.faction === "player") u.alive = false;
    }
    // Enemies and civilians are still standing.
    expect(livingUnits(state, "enemy").length).toBeGreaterThan(0);
    expect(livingUnits(state, "civilian").length).toBe(6);
    const over = checkVictory(state);
    expect(over).toEqual({ type: "gameOver", status: "enemy_win" });
    expect(state.status).toBe("enemy_win");
  });
});

describe("enemy AI hunts civilians", () => {
  it("shoots a visible civilian when no better target is available", () => {
    // Enemy at (10,5) facing W toward a civilian at (6,5): visible, in range,
    // clear LOS. No players on the field, so the civilian is the only target.
    const enemy = makeUnit(2, "enemy", { x: 10, y: 5 }, 6 /* W */);
    const civilian = makeUnit(1, "civilian", { x: 6, y: 5 }, 2 /* E */);
    const state = makeState([enemy, civilian]);

    const events = runEnemyTurn(state, makeExec(state));
    const shots = events.filter(
      (e) =>
        e.type === "shot" &&
        e.targetPos.x === civilian.pos.x &&
        e.targetPos.y === civilian.pos.y,
    );
    expect(shots.length).toBeGreaterThanOrEqual(1);
    // The alien (not the civilian) is always the firer.
    expect(shots.every((e) => e.type === "shot" && e.shooterId === enemy.id)).toBe(true);
  });

  it("ignores a civilian it cannot see (out of the vision cone)", () => {
    // Enemy at (10,5) facing W; civilian at (14,5) is due EAST — behind the
    // alien, outside its vision cone, so it is never a valid shot target.
    const enemy = makeUnit(2, "enemy", { x: 10, y: 5 }, 6 /* W */);
    const civilian = makeUnit(1, "civilian", { x: 14, y: 5 }, 6 /* W */);
    const state = makeState([enemy, civilian]);

    const events = runEnemyTurn(state, makeExec(state));
    expect(events.some((e) => e.type === "shot")).toBe(false);
    // The untouched civilian is never the firer either.
    expect(events.some((e) => e.type === "shot" && e.shooterId === civilian.id)).toBe(false);
  });

  it("civilians never act during the enemy turn and never start a turn", () => {
    const enemy = makeUnit(2, "enemy", { x: 10, y: 5 }, 6 /* W */);
    const civilian = makeUnit(1, "civilian", { x: 6, y: 5 }, 2 /* E */);
    const state = makeState([enemy, civilian]);

    const events = runEnemyTurn(state, makeExec(state));
    // A civilian is never the actor: never fires, never moves.
    expect(events.some((e) => e.type === "shot" && e.shooterId === civilian.id)).toBe(false);
    expect(events.some((e) => e.type === "moveStep" && e.unitId === civilian.id)).toBe(false);

    // The full turn cycle (player -> enemy -> player) never hands control to a
    // civilian faction.
    const battle = createSkirmish({ seed: 3, objectiveKind: "rescue", civilianCount: 4 });
    const cycle = applyCommand(battle, { type: "endTurn" });
    const turnStarts = cycle.filter((e) => e.type === "turnStarted");
    expect(turnStarts.every((e) => e.type === "turnStarted" && e.faction !== "civilian")).toBe(true);
    expect(battle.activeFaction).not.toBe("civilian");
  });
});
