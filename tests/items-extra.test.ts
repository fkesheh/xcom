import { describe, it, expect } from "vitest";
import { Rng } from "../src/sim/rng";
import { makeGrid, setTile, WALL } from "../src/sim/grid";
import { applyCommand, executeMove, unitById } from "../src/sim/battle";
import { visibleEnemyIds } from "../src/sim/los";
import { ITEMS, WEAPONS } from "../src/sim/content";
import { MORALE } from "../src/sim/types";
import type {
  BattleState,
  Dir8,
  Faction,
  ItemInstance,
  Unit,
  UnitId,
  Vec2,
} from "../src/sim/types";

// ---------------------------------------------------------------------------
// Test factories. Mirrors tests/tactical-items.test.ts: populates morale +
// items so units opt into the full item system, and seeds state.items with the
// catalogue (so scanner + proxMine resolve their definitions).
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
    templateId: "trooper",
    faction,
    pos,
    facing,
    stats: {
      timeUnits: 60,
      health: 40,
      reactions: 40,
      firingAccuracy: 60,
      strength: 30,
      bravery: 50,
    },
    tu: 60,
    hp: 40,
    morale: MORALE.MAX,
    items: [],
    weaponId: "rifle",
    ammo: 24,
    alive: true,
    reserve: "none",
    sightRange: 20,
    visionHalfAngleDeg: 60,
    ...overrides,
  };
}

function scanner(uses = 1): ItemInstance {
  return { itemId: "scanner", uses };
}
function proxMine(uses = 1): ItemInstance {
  return { itemId: "proxMine", uses };
}

function makeState(units: Unit[], seed = 1234): BattleState {
  return {
    grid: makeGrid(30, 30),
    units,
    weapons: WEAPONS,
    items: { ...ITEMS },
    turn: 1,
    activeFaction: "player",
    rng: new Rng(seed),
    status: "playing",
    explored: new Set<number>(),
    log: [],
  };
}

// ---------------------------------------------------------------------------
// Motion scanner
// ---------------------------------------------------------------------------

describe("motion scanner (useItem)", () => {
  it("reveals nearby enemies THROUGH walls for the rest of the turn", () => {
    // Player faces south toward an enemy 8 tiles away (within scanRadius 8). A
    // wall column sits between them on the direct line, so the enemy is in range
    // and inside the vision cone but has NO line of sight — invisible until the
    // scanner pings movement through the obstruction.
    const player = makeUnit(1, "player", { x: 5, y: 5 }, 4, {
      items: [scanner()],
      stats: { timeUnits: 60, health: 40, reactions: 40, firingAccuracy: 60, strength: 30, bravery: 50 },
    });
    const hiddenEnemy = makeUnit(2, "enemy", { x: 5, y: 13 }, 0, { hp: 100 });
    const state = makeState([player, hiddenEnemy], 42);
    for (const y of [8, 9, 10]) setTile(state.grid, 5, y, WALL);

    // Sanity: without the scanner, the wall blocks sight — the enemy is unseen.
    expect(visibleEnemyIds(state, "player").has(2)).toBe(false);

    const events = applyCommand(state, {
      type: "useItem",
      unitId: 1,
      targetId: 1, // self-use device
      itemId: "scanner",
    });

    // A scanActivated event fires and the reveal stamp lands on the unit.
    const scan = events.find((e) => e.type === "scanActivated");
    expect(scan).toBeDefined();
    if (scan?.type === "scanActivated") {
      expect(scan.radius).toBe(8);
      expect(scan.tuLeft).toBe(60 - 15); // scanner tuPercent 25 of 60 => ceil(15)
    }
    expect(player.scanRadius).toBe(8);

    // The scanner now reveals the wall-hidden enemy: visibleEnemyIds includes it
    // despite the blocked line of sight.
    expect(visibleEnemyIds(state, "player").has(2)).toBe(true);

    // Single-use scanner is consumed on activation.
    expect(player.items?.find((i) => i.itemId === "scanner")).toBeUndefined();
  });

  it("is blocked without enough TU and leaves the reveal off", () => {
    const player = makeUnit(1, "player", { x: 5, y: 5 }, 4, {
      items: [scanner()],
      tu: 5, // scanner costs 15 TU
    });
    const enemy = makeUnit(2, "enemy", { x: 5, y: 6 }, 0);
    const state = makeState([player, enemy]);

    const events = applyCommand(state, { type: "useItem", unitId: 1, targetId: 1, itemId: "scanner" });
    expect(events).toEqual([{ type: "blocked", reason: "not enough TU" }]);
    expect(player.scanRadius).toBeUndefined();
    expect(player.items?.find((i) => i.itemId === "scanner")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Proximity mine
// ---------------------------------------------------------------------------

describe("proximity mine (throwItem + executeMove)", () => {
  it("plants at the target tile with no immediate blast", () => {
    const thrower = makeUnit(1, "player", { x: 5, y: 5 }, 0, {
      items: [proxMine()],
      stats: { timeUnits: 60, health: 40, reactions: 40, firingAccuracy: 60, strength: 30, bravery: 50 },
    });
    const state = makeState([thrower], 7);

    const events = applyCommand(state, {
      type: "throwItem",
      unitId: 1,
      target: { x: 10, y: 5 },
      itemId: "proxMine",
    });

    // Placed, not detonated: a minePlaced event and a stored mine, no blast.
    expect(events.some((e) => e.type === "minePlaced")).toBe(true);
    expect(events.some((e) => e.type === "blastDetonated")).toBe(false);
    expect(state.mines).toEqual([
      { pos: { x: 10, y: 5 }, radius: 2, damage: 50, placedByFaction: "player" },
    ]);
    // TU spent (tuPercent 35 of 60 => ceil(21)) and the charge consumed.
    expect(thrower.tu).toBe(60 - 21);
    expect(thrower.items?.find((i) => i.itemId === "proxMine")).toBeUndefined();
  });

  it("detonates when an enemy moves adjacent, damaging the mover", () => {
    // Player plants a mine, then an enemy steps adjacent to it (simulated by
    // calling executeMove directly so the trigger is exercised deterministically
    // without routing through the enemy AI).
    const thrower = makeUnit(1, "player", { x: 5, y: 5 }, 0, {
      items: [proxMine()],
      stats: { timeUnits: 60, health: 40, reactions: 40, firingAccuracy: 60, strength: 30, bravery: 50 },
    });
    const enemy = makeUnit(2, "enemy", { x: 12, y: 5 }, 6, {
      hp: 200,
      stats: { timeUnits: 60, health: 200, reactions: 40, firingAccuracy: 60, strength: 30, bravery: 50 },
    });
    const state = makeState([thrower, enemy], 99);

    applyCommand(state, { type: "throwItem", unitId: 1, target: { x: 10, y: 5 }, itemId: "proxMine" });
    expect(state.mines).toHaveLength(1);

    const hpBefore = enemy.hp;
    // Enemy advances one tile toward the mine, landing adjacent (distance 1).
    const events = executeMove(state, 2, { x: 11, y: 5 });

    // The mine tripped: a blast centered on the planted tile, the mover hit.
    const blast = events.find(
      (e) => e.type === "blastDetonated" && e.center.x === 10 && e.center.y === 5,
    );
    expect(blast).toBeDefined();
    if (blast?.type === "blastDetonated") {
      expect(blast.itemId).toBe("proxMine");
      expect(blast.hits.map((h) => h.unitId)).toContain(2);
    }
    expect(enemy.hp).toBeLessThan(hpBefore); // took blast damage
    expect(state.mines ?? []).toEqual([]); // spent mine removed
  });

  it("does NOT trigger for the placer's faction", () => {
    // A player-planted mine stays inert when a friendly unit moves adjacent.
    const thrower = makeUnit(1, "player", { x: 5, y: 5 }, 0, {
      items: [proxMine()],
      stats: { timeUnits: 60, health: 40, reactions: 40, firingAccuracy: 60, strength: 30, bravery: 50 },
    });
    const ally = makeUnit(3, "player", { x: 12, y: 5 }, 6, {
      hp: 200,
      stats: { timeUnits: 60, health: 200, reactions: 40, firingAccuracy: 60, strength: 30, bravery: 50 },
    });
    const state = makeState([thrower, ally], 3);

    applyCommand(state, { type: "throwItem", unitId: 1, target: { x: 10, y: 5 }, itemId: "proxMine" });

    const hpBefore = ally.hp;
    const events = executeMove(state, 3, { x: 11, y: 5 }); // adjacent to the mine

    // Friendly mover: no detonation, mine remains armed, ally unharmed.
    expect(events.some((e) => e.type === "blastDetonated")).toBe(false);
    expect(state.mines ?? []).toEqual([
      { pos: { x: 10, y: 5 }, radius: 2, damage: 50, placedByFaction: "player" },
    ]);
    expect(ally.hp).toBe(hpBefore);
  });

  it("detonates when a mover steps ON the mined tile", () => {
    const thrower = makeUnit(1, "player", { x: 5, y: 5 }, 0, {
      items: [proxMine()],
      stats: { timeUnits: 60, health: 40, reactions: 40, firingAccuracy: 60, strength: 30, bravery: 50 },
    });
    const enemy = makeUnit(2, "enemy", { x: 11, y: 5 }, 6, {
      hp: 200,
      stats: { timeUnits: 60, health: 200, reactions: 40, firingAccuracy: 60, strength: 30, bravery: 50 },
    });
    const state = makeState([thrower, enemy], 12);

    applyCommand(state, { type: "throwItem", unitId: 1, target: { x: 10, y: 5 }, itemId: "proxMine" });
    const hpBefore = enemy.hp;

    // Step directly onto the mined tile (distance 0).
    const events = executeMove(state, 2, { x: 10, y: 5 });

    expect(events.some((e) => e.type === "blastDetonated" && e.center.x === 10 && e.center.y === 5)).toBe(true);
    expect(enemy.hp).toBeLessThan(hpBefore);
    expect(state.mines ?? []).toEqual([]);
  });

  it("is blocked when thrown beyond throw range", () => {
    const thrower = makeUnit(1, "player", { x: 5, y: 5 }, 0, { items: [proxMine()] });
    const state = makeState([thrower]);
    const events = applyCommand(state, {
      type: "throwItem",
      unitId: 1,
      target: { x: 20, y: 5 }, // 15 tiles away, throwRange is 8
      itemId: "proxMine",
    });
    expect(events).toEqual([{ type: "blocked", reason: "out of throw range" }]);
    expect(state.mines ?? []).toEqual([]);
    expect(thrower.items?.find((i) => i.itemId === "proxMine")).toBeDefined();
  });
});
