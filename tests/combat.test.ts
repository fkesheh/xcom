import { describe, it, expect } from "vitest";
import { Rng } from "../src/sim/rng";
import { makeGrid, setTile, WALL } from "../src/sim/grid";
import {
  tileDistance,
  effectiveAccuracy,
  spreadForAccuracy,
  targetHalfAngle,
  hitChance,
  tuCostForMode,
  findMode,
  previewShot,
  resolveShot,
} from "../src/sim/combat";
import { COMBAT } from "../src/sim/types";
import type {
  BattleState,
  Dir8,
  Faction,
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
      reactions: 30,
      firingAccuracy: 60,
      strength: 30,
    },
    tu: 60,
    hp: 30,
    weaponId: "rifle",
    ammo: 24,
    alive: true,
    reserve: "none",
    sightRange: 20,
    visionHalfAngleDeg: 45,
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

function makeState(units: Unit[], weapon: Weapon = makeWeapon(), seed = 1234): BattleState {
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

describe("tileDistance", () => {
  it("is Euclidean", () => {
    expect(tileDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBeCloseTo(5);
    expect(tileDistance({ x: 2, y: 2 }, { x: 2, y: 2 })).toBe(0);
  });
});

describe("effectiveAccuracy", () => {
  const weapon = makeWeapon();
  const snap = findMode(weapon, "snap")!;
  const shooter = makeUnit(1, "enemy", { x: 0, y: 0 }, 0);

  it("multiplies firing accuracy by mode accuracy within range", () => {
    // 60% firing * 60% mode = 0.36, range factor 1
    const acc = effectiveAccuracy(shooter, weapon, snap, 5);
    expect(acc).toBeCloseTo(0.36);
  });

  it("falls off beyond effective range but never below 0.05 factor", () => {
    const near = effectiveAccuracy(shooter, weapon, snap, weapon.range);
    const far = effectiveAccuracy(shooter, weapon, snap, weapon.range + 10);
    expect(far).toBeLessThan(near);
    // Very far: range factor clamps to >= 0.05
    const veryFar = effectiveAccuracy(shooter, weapon, snap, weapon.range + 1000);
    expect(veryFar).toBeGreaterThanOrEqual(0.36 * 0.05 - 1e-9);
  });

  it("clamps the result into [0, 1]", () => {
    const aimed = findMode(weapon, "aimed")!; // accuracy 110
    const ace = makeUnit(2, "enemy", { x: 0, y: 0 }, 0, {
      stats: { ...shooter.stats, firingAccuracy: 120 },
    });
    const acc = effectiveAccuracy(ace, weapon, aimed, 1);
    expect(acc).toBeLessThanOrEqual(1);
    expect(acc).toBeGreaterThanOrEqual(0);
  });
});

describe("spreadForAccuracy", () => {
  it("lerps between the configured endpoints", () => {
    expect(spreadForAccuracy(0)).toBeCloseTo(COMBAT.SPREAD_AT_0_RAD);
    expect(spreadForAccuracy(1)).toBeCloseTo(COMBAT.SPREAD_AT_100_RAD);
    const mid = spreadForAccuracy(0.5);
    expect(mid).toBeLessThan(COMBAT.SPREAD_AT_0_RAD);
    expect(mid).toBeGreaterThan(COMBAT.SPREAD_AT_100_RAD);
  });
});

describe("targetHalfAngle", () => {
  it("shrinks with distance and is monotonic decreasing", () => {
    const near = targetHalfAngle(2);
    const far = targetHalfAngle(20);
    expect(near).toBeGreaterThan(far);
    expect(far).toBeGreaterThan(0);
  });
});

describe("hitChance", () => {
  const weapon = makeWeapon();
  const snap = findMode(weapon, "snap")!;

  it("is higher when the target is closer (monotonic in distance)", () => {
    const shooter = makeUnit(1, "enemy", { x: 0, y: 0 }, 0);
    const close = hitChance(shooter, weapon, snap, 3);
    const mid = hitChance(shooter, weapon, snap, 6);
    const farther = hitChance(shooter, weapon, snap, 10);
    expect(close).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(farther);
  });

  it("is higher for a more accurate shooter at the same distance", () => {
    const poor = makeUnit(1, "enemy", { x: 0, y: 0 }, 0, {
      stats: {
        timeUnits: 60,
        health: 30,
        reactions: 30,
        firingAccuracy: 30,
        strength: 30,
      },
    });
    const ace = makeUnit(2, "enemy", { x: 0, y: 0 }, 0, {
      stats: {
        timeUnits: 60,
        health: 30,
        reactions: 30,
        firingAccuracy: 90,
        strength: 30,
      },
    });
    expect(hitChance(ace, weapon, snap, 6)).toBeGreaterThan(
      hitChance(poor, weapon, snap, 6),
    );
  });

  it("never exceeds MAX_HIT_CHANCE nor drops below MIN_HIT_CHANCE", () => {
    const ace = makeUnit(1, "enemy", { x: 0, y: 0 }, 0, {
      stats: {
        timeUnits: 60,
        health: 30,
        reactions: 30,
        firingAccuracy: 120,
        strength: 30,
      },
    });
    const aimed = findMode(weapon, "aimed")!;
    const point = hitChance(ace, weapon, aimed, 1);
    expect(point).toBeLessThanOrEqual(COMBAT.MAX_HIT_CHANCE);
    expect(point).toBeGreaterThanOrEqual(COMBAT.MIN_HIT_CHANCE);
  });
});

describe("tuCostForMode", () => {
  it("is a ceil of the percentage of max TU", () => {
    const weapon = makeWeapon();
    const u = makeUnit(1, "enemy", { x: 0, y: 0 }, 0, {
      stats: {
        timeUnits: 50,
        health: 30,
        reactions: 30,
        firingAccuracy: 60,
        strength: 30,
      },
    });
    // 25% of 50 = 12.5 -> ceil 13
    expect(tuCostForMode(u, findMode(weapon, "snap")!)).toBe(13);
    // 50% of 50 = 25
    expect(tuCostForMode(u, findMode(weapon, "aimed")!)).toBe(25);
  });
});

describe("findMode", () => {
  it("returns the matching mode or undefined", () => {
    const weapon = makeWeapon();
    expect(findMode(weapon, "snap")?.kind).toBe("snap");
    expect(findMode(weapon, "auto")?.shots).toBe(3);
    expect(findMode({ ...weapon, modes: [] }, "snap")).toBeUndefined();
  });
});

describe("previewShot", () => {
  it("is possible with LOS and enough TU; reports honest odds", () => {
    const shooter = makeUnit(1, "enemy", { x: 1, y: 5 }, 2 /* E */);
    const target = makeUnit(2, "player", { x: 6, y: 5 }, 6);
    const state = makeState([shooter, target]);
    const p = previewShot(state, shooter, target.pos, "snap");
    expect(p.possible).toBe(true);
    expect(p.reason).toBeUndefined();
    expect(p.hitChance).toBeGreaterThan(0);
    expect(p.expectedHits).toBeCloseTo(p.hitChance * 1);
    expect(p.tuCost).toBe(tuCostForMode(shooter, findMode(makeWeapon(), "snap")!));
    expect(p.ammoCost).toBe(1);
  });

  it("expectedHits scales with the number of shots (auto)", () => {
    const shooter = makeUnit(1, "enemy", { x: 1, y: 5 }, 2);
    const target = makeUnit(2, "player", { x: 6, y: 5 }, 6);
    const state = makeState([shooter, target]);
    const p = previewShot(state, shooter, target.pos, "auto");
    expect(p.expectedHits).toBeCloseTo(p.hitChance * 3);
  });

  it("is blocked with no line of fire (full wall, no open side)", () => {
    const shooter = makeUnit(1, "enemy", { x: 1, y: 5 }, 2);
    const target = makeUnit(2, "player", { x: 6, y: 5 }, 6);
    const state = makeState([shooter, target]);
    // Full wall column between shooter and target: leaning can't get around it.
    for (let y = 0; y < 30; y++) setTile(state.grid, 3, y, WALL);
    const p = previewShot(state, shooter, target.pos, "snap");
    expect(p.possible).toBe(false);
    expect(p.reason).toBe("no line of fire");
  });

  it("becomes possible by peeking when a single wall is hugged but a side is open", () => {
    const shooter = makeUnit(1, "enemy", { x: 5, y: 5 }, 0 /* N */);
    const target = makeUnit(2, "player", { x: 5, y: 3 }, 4);
    const state = makeState([shooter, target]);
    // Wall hugged directly between shooter and target: the center line is
    // blocked but a lean tile to either side has a clear angle.
    setTile(state.grid, 5, 4, WALL);
    const p = previewShot(state, shooter, target.pos, "snap");
    expect(p.possible).toBe(true);
    expect(p.reason).toBeUndefined();
  });

  it("is blocked when the shooter lacks TU", () => {
    const shooter = makeUnit(1, "enemy", { x: 1, y: 5 }, 2, { tu: 2 });
    const target = makeUnit(2, "player", { x: 6, y: 5 }, 6);
    const state = makeState([shooter, target]);
    const p = previewShot(state, shooter, target.pos, "snap");
    expect(p.possible).toBe(false);
    expect(p.reason).toBe("not enough TU");
  });

  it("is blocked when the magazine cannot cover the firing mode", () => {
    const target = makeUnit(2, "player", { x: 6, y: 5 }, 6);
    const empty = makeUnit(1, "enemy", { x: 1, y: 5 }, 2, { ammo: 0 });
    const low = makeUnit(3, "enemy", { x: 1, y: 6 }, 2, { ammo: 2 });

    const emptyPreview = previewShot(makeState([empty, target]), empty, target.pos, "snap");
    const autoPreview = previewShot(makeState([low, target]), low, target.pos, "auto");

    expect(emptyPreview.possible).toBe(false);
    expect(emptyPreview.reason).toBe("empty magazine");
    expect(emptyPreview.ammoCost).toBe(1);
    expect(autoPreview.possible).toBe(false);
    expect(autoPreview.reason).toBe("not enough ammo");
    expect(autoPreview.ammoCost).toBe(3);
  });

  it("is blocked when the weapon has no such mode", () => {
    const weapon = makeWeapon({
      modes: [{ kind: "snap", tuPercent: 25, accuracy: 60, shots: 1 }],
    });
    const shooter = makeUnit(1, "enemy", { x: 1, y: 5 }, 2);
    const target = makeUnit(2, "player", { x: 6, y: 5 }, 6);
    const state = makeState([shooter, target], weapon);
    const p = previewShot(state, shooter, target.pos, "aimed");
    expect(p.possible).toBe(false);
    expect(p.reason).toBeDefined();
  });

  it("does NOT advance the rng", () => {
    const shooter = makeUnit(1, "enemy", { x: 1, y: 5 }, 2);
    const target = makeUnit(2, "player", { x: 6, y: 5 }, 6);
    const state = makeState([shooter, target]);
    const before = state.rng.state;
    previewShot(state, shooter, target.pos, "snap");
    previewShot(state, shooter, target.pos, "auto");
    expect(state.rng.state).toBe(before);
  });
});

describe("resolveShot", () => {
  it("is deterministic for the same seed + state", () => {
    const build = () => {
      const shooter = makeUnit(1, "enemy", { x: 1, y: 5 }, 2);
      const target = makeUnit(2, "player", { x: 6, y: 5 }, 6, { hp: 1000 });
      return makeState([shooter, target], makeWeapon(), 99);
    };
    const a = build();
    const ra = resolveShot(a, a.units[0]!, a.units[1]!.pos, "auto");
    const b = build();
    const rb = resolveShot(b, b.units[0]!, b.units[1]!.pos, "auto");
    expect(ra.rounds).toEqual(rb.rounds);
    expect(ra.targetId).toBe(rb.targetId);
    expect(ra.killed).toBe(rb.killed);
  });

  it("advances the rng (it rolls dice)", () => {
    const shooter = makeUnit(1, "enemy", { x: 1, y: 5 }, 2);
    const target = makeUnit(2, "player", { x: 6, y: 5 }, 6, { hp: 1000 });
    const state = makeState([shooter, target]);
    const before = state.rng.state;
    resolveShot(state, shooter, target.pos, "snap");
    expect(state.rng.state).not.toBe(before);
  });

  it("damages and can kill the occupant at the target tile", () => {
    // Adjacent + high accuracy => spread <= target half-angle => guaranteed hits.
    const weapon = makeWeapon({ damage: 100 });
    const shooter = makeUnit(1, "enemy", { x: 5, y: 5 }, 2, {
      stats: {
        timeUnits: 60,
        health: 30,
        reactions: 30,
        firingAccuracy: 100,
        strength: 30,
      },
    });
    const target = makeUnit(2, "player", { x: 6, y: 5 }, 6, { hp: 10 });
    const state = makeState([shooter, target], weapon, 7);
    const res = resolveShot(state, shooter, target.pos, "snap");
    expect(res.rounds[0]!.hit).toBe(true);
    expect(res.rounds[0]!.damage).toBeGreaterThan(0);
    expect(res.targetId).toBe(2);
    expect(res.killed).toBe(true);
    expect(target.hp).toBe(0);
    expect(target.alive).toBe(false);
  });

  it("targetId is null when no living unit occupies the tile", () => {
    const shooter = makeUnit(1, "enemy", { x: 5, y: 5 }, 2);
    const state = makeState([shooter]);
    const res = resolveShot(state, shooter, { x: 6, y: 5 }, "snap");
    expect(res.targetId).toBeNull();
    expect(res.killed).toBe(false);
  });

  it("does not deduct shooter TU (the reducer does that)", () => {
    const shooter = makeUnit(1, "enemy", { x: 5, y: 5 }, 2, { tu: 60 });
    const target = makeUnit(2, "player", { x: 6, y: 5 }, 6, { hp: 1000 });
    const state = makeState([shooter, target]);
    resolveShot(state, shooter, target.pos, "snap");
    expect(shooter.tu).toBe(60);
  });

  it("samples against the previewed (capped) hit chance, not a sure thing", () => {
    // Point blank + high accuracy: geometrically a guaranteed hit, but the
    // preview reports the 0.99 cap. resolveShot must agree with the preview.
    const weapon = makeWeapon();
    const shooter = makeUnit(1, "enemy", { x: 5, y: 5 }, 2, {
      stats: {
        timeUnits: 60,
        health: 30,
        reactions: 30,
        firingAccuracy: 100,
        strength: 30,
      },
    });
    const target = makeUnit(2, "player", { x: 6, y: 5 }, 6, { hp: 1_000_000 });
    const state = makeState([shooter, target], weapon, 2024);

    const preview = previewShot(state, shooter, target.pos, "snap");
    expect(preview.hitChance).toBeCloseTo(COMBAT.MAX_HIT_CHANCE, 6);

    const N = 4000;
    let hits = 0;
    for (let i = 0; i < N; i++) {
      if (resolveShot(state, shooter, target.pos, "snap").rounds[0]!.hit) hits++;
    }
    const frac = hits / N;
    expect(frac).toBeLessThan(1); // the cap bites: not a literal certainty
    expect(Math.abs(frac - preview.hitChance)).toBeLessThan(0.02);
  });
});
