import { describe, it, expect } from "vitest";
import { Rng } from "../src/sim/rng";
import { makeGrid, setTile, WALL } from "../src/sim/grid";
import { reactionScore, triggerReactions } from "../src/sim/reaction";
import type {
  BattleState,
  Dir8,
  Faction,
  GameEvent,
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
      reactions: 50,
      firingAccuracy: 90,
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
    damage: 100,
    range: 15,
    magazineSize: 24,
    reloadTuPercent: 20,
    modes: [
      { kind: "snap", tuPercent: 25, accuracy: 90, shots: 1 },
      { kind: "aimed", tuPercent: 50, accuracy: 110, shots: 1 },
      { kind: "auto", tuPercent: 35, accuracy: 60, shots: 3 },
    ],
    ...overrides,
  };
}

function makeState(
  units: Unit[],
  weapon: Weapon = makeWeapon(),
  seed = 4242,
): BattleState {
  return {
    grid: makeGrid(30, 30),
    units,
    weapons: { [weapon.id]: weapon },
    turn: 1,
    activeFaction: "player",
    rng: new Rng(seed),
    status: "playing",
    explored: new Set<number>(),
    log: [],
  };
}

function shots(events: GameEvent[]): Extract<GameEvent, { type: "shot" }>[] {
  return events.filter((e): e is Extract<GameEvent, { type: "shot" }> => e.type === "shot");
}

describe("reactionScore", () => {
  it("is reactions scaled by current TU fraction", () => {
    const u = makeUnit(1, "enemy", { x: 0, y: 0 }, 0, {
      stats: {
        timeUnits: 100,
        health: 30,
        reactions: 40,
        firingAccuracy: 60,
        strength: 30,
      },
      tu: 50,
    });
    expect(reactionScore(u)).toBeCloseTo(20); // 40 * (50/100)
  });
});

describe("triggerReactions", () => {
  it("a high-reaction defender in the cone interrupts a low-reaction mover", () => {
    // Defender (enemy) at (10,5) facing W toward the mover (player) at (5,5).
    const defender = makeUnit(2, "enemy", { x: 10, y: 5 }, 6 /* W */, {
      stats: {
        timeUnits: 60,
        health: 30,
        reactions: 80,
        firingAccuracy: 90,
        strength: 30,
      },
      tu: 60,
    });
    const mover = makeUnit(1, "player", { x: 5, y: 5 }, 2 /* E */, {
      stats: {
        timeUnits: 60,
        health: 30,
        reactions: 10,
        firingAccuracy: 60,
        strength: 30,
      },
      tu: 40,
      hp: 1000, // survive so we can observe the reaction shot
    });
    const state = makeState([mover, defender]);
    const events = triggerReactions(state, mover);
    const fired = shots(events);
    expect(fired.length).toBeGreaterThanOrEqual(1);
    expect(fired[0]!.shooterId).toBe(2);
    expect(fired[0]!.reaction).toBe(true);
    expect(defender.ammo).toBeLessThan(24);
    expect(fired[0]!.targetPos).toEqual({ x: 5, y: 5 });
    // TU was deducted from the reactor for the snap shot.
    expect(defender.tu).toBeLessThan(60);
  });

  it("does NOT react when a wall blocks the line of sight", () => {
    const defender = makeUnit(2, "enemy", { x: 10, y: 5 }, 6, {
      stats: {
        timeUnits: 60,
        health: 30,
        reactions: 80,
        firingAccuracy: 90,
        strength: 30,
      },
    });
    const mover = makeUnit(1, "player", { x: 5, y: 5 }, 2, {
      stats: {
        timeUnits: 60,
        health: 30,
        reactions: 10,
        firingAccuracy: 60,
        strength: 30,
      },
    });
    const state = makeState([mover, defender]);
    // Full wall column: no open side for the defender to lean past and react.
    for (let y = 0; y < 30; y++) setTile(state.grid, 7, y, WALL);
    expect(triggerReactions(state, mover)).toHaveLength(0);
    expect(defender.tu).toBe(60);
  });

  it("does NOT react when the mover is outside the defender's vision cone", () => {
    // Defender faces away (E) while the mover is to the W.
    const defender = makeUnit(2, "enemy", { x: 10, y: 5 }, 2 /* E */, {
      stats: {
        timeUnits: 60,
        health: 30,
        reactions: 80,
        firingAccuracy: 90,
        strength: 30,
      },
    });
    const mover = makeUnit(1, "player", { x: 5, y: 5 }, 2, {
      stats: {
        timeUnits: 60,
        health: 30,
        reactions: 10,
        firingAccuracy: 60,
        strength: 30,
      },
    });
    const state = makeState([mover, defender]);
    expect(triggerReactions(state, mover)).toHaveLength(0);
  });

  it("does NOT react when the defender's reaction score does not strictly beat the mover", () => {
    // Equal scores: ties favour the active mover (strict >).
    const defender = makeUnit(2, "enemy", { x: 10, y: 5 }, 6, {
      stats: {
        timeUnits: 60,
        health: 30,
        reactions: 30,
        firingAccuracy: 90,
        strength: 30,
      },
      tu: 60,
    });
    const mover = makeUnit(1, "player", { x: 5, y: 5 }, 2, {
      stats: {
        timeUnits: 60,
        health: 30,
        reactions: 30,
        firingAccuracy: 60,
        strength: 30,
      },
      tu: 60,
    });
    const state = makeState([mover, defender]);
    expect(triggerReactions(state, mover)).toHaveLength(0);
  });

  it("does NOT react when the defender cannot afford a snap shot", () => {
    const defender = makeUnit(2, "enemy", { x: 10, y: 5 }, 6, {
      stats: {
        timeUnits: 60,
        health: 30,
        reactions: 80,
        firingAccuracy: 90,
        strength: 30,
      },
      tu: 5, // snap costs ceil(0.25*60)=15
    });
    const mover = makeUnit(1, "player", { x: 5, y: 5 }, 2, {
      stats: {
        timeUnits: 60,
        health: 30,
        reactions: 10,
        firingAccuracy: 60,
        strength: 30,
      },
    });
    const state = makeState([mover, defender]);
    expect(triggerReactions(state, mover)).toHaveLength(0);
  });

  it("cannot react with a weapon that has no snap mode", () => {
    const noSnap = makeWeapon({
      modes: [{ kind: "aimed", tuPercent: 50, accuracy: 110, shots: 1 }],
    });
    const defender = makeUnit(2, "enemy", { x: 10, y: 5 }, 6, {
      stats: {
        timeUnits: 60,
        health: 30,
        reactions: 80,
        firingAccuracy: 90,
        strength: 30,
      },
    });
    const mover = makeUnit(1, "player", { x: 5, y: 5 }, 2, {
      stats: {
        timeUnits: 60,
        health: 30,
        reactions: 10,
        firingAccuracy: 60,
        strength: 30,
      },
    });
    const state = makeState([mover, defender], noSnap);
    expect(triggerReactions(state, mover)).toHaveLength(0);
  });

  it("cannot react with an empty magazine", () => {
    const defender = makeUnit(2, "enemy", { x: 10, y: 5 }, 6, {
      ammo: 0,
      stats: {
        timeUnits: 60,
        health: 30,
        reactions: 80,
        firingAccuracy: 90,
        strength: 30,
      },
    });
    const mover = makeUnit(1, "player", { x: 5, y: 5 }, 2, {
      stats: {
        timeUnits: 60,
        health: 30,
        reactions: 10,
        firingAccuracy: 60,
        strength: 30,
      },
    });
    const state = makeState([mover, defender]);

    expect(triggerReactions(state, mover)).toHaveLength(0);
    expect(defender.ammo).toBe(0);
  });

  it("emits a died event and stops when the mover is killed", () => {
    const defender = makeUnit(2, "enemy", { x: 6, y: 5 }, 6, {
      stats: {
        timeUnits: 60,
        health: 30,
        reactions: 80,
        firingAccuracy: 100,
        strength: 30,
      },
      tu: 60,
    });
    const mover = makeUnit(1, "player", { x: 5, y: 5 }, 2, {
      stats: {
        timeUnits: 60,
        health: 30,
        reactions: 10,
        firingAccuracy: 60,
        strength: 30,
      },
      tu: 60,
      hp: 1, // one hit (damage 100) is lethal
    });
    const state = makeState([mover, defender]);
    const events = triggerReactions(state, mover);
    expect(events.some((e) => e.type === "died" && e.unitId === 1)).toBe(true);
    expect(mover.alive).toBe(false);
    // Only one reaction shot should have fired before stopping.
    expect(shots(events)).toHaveLength(1);
  });

  it("faces the reactor toward the mover before firing", () => {
    const defender = makeUnit(2, "enemy", { x: 10, y: 5 }, 0 /* N initially */, {
      stats: {
        timeUnits: 60,
        health: 30,
        reactions: 80,
        firingAccuracy: 90,
        strength: 30,
      },
      // Wide cone so the mover is still seen before re-facing.
      visionHalfAngleDeg: 180,
    });
    const mover = makeUnit(1, "player", { x: 5, y: 5 }, 2, {
      stats: {
        timeUnits: 60,
        health: 30,
        reactions: 10,
        firingAccuracy: 60,
        strength: 30,
      },
      hp: 1000,
    });
    const state = makeState([mover, defender]);
    triggerReactions(state, mover);
    expect(defender.facing).toBe(6); // now facing W toward the mover
  });
});
