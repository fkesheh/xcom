import { describe, it, expect } from "vitest";
import { createSkirmish } from "../src/sim/setup";
import { blocksMove, tileTypeAt } from "../src/sim/grid";
import { WEAPONS } from "../src/sim/content";
import type { Vec2 } from "../src/sim/types";

function centroid(points: Vec2[]): Vec2 {
  if (points.length === 0) return { x: 0, y: 0 };
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

describe("createSkirmish", () => {
  it("deploys the squad and hostiles on walkable, well-separated tiles", () => {
    const state = createSkirmish({ seed: 1234, players: 4, enemies: 6 });

    const players = state.units.filter((u) => u.faction === "player");
    const enemies = state.units.filter((u) => u.faction === "enemy");
    expect(players).toHaveLength(4);
    expect(enemies).toHaveLength(6);

    // Every unit stands on a walkable, non-overlapping tile with full TU/HP.
    for (const u of state.units) {
      expect(blocksMove(state.grid, u.pos.x, u.pos.y)).toBe(false);
      expect(u.alive).toBe(true);
      expect(u.tu).toBe(u.stats.timeUnits);
      expect(u.hp).toBe(u.stats.health);
    }
    const seen = new Set(state.units.map((u) => `${u.pos.x},${u.pos.y}`));
    expect(seen.size).toBe(state.units.length);

    // The squad deploys near the dropship and the hostiles around the UFO, so
    // the two masses start clearly separated.
    const pc = centroid(players.map((u) => u.pos));
    const ec = centroid(enemies.map((u) => u.pos));
    expect(Math.max(Math.abs(pc.x - ec.x), Math.abs(pc.y - ec.y))).toBeGreaterThan(5);

    // No hostile starts adjacent to (or on top of) a trooper.
    for (const p of players) {
      for (const e of enemies) {
        const cheb = Math.max(Math.abs(p.pos.x - e.pos.x), Math.abs(p.pos.y - e.pos.y));
        expect(cheb).toBeGreaterThan(1);
      }
    }
  });

  it("records the generated terrain theme", () => {
    const state = createSkirmish({ seed: 1234 });
    expect(["farmland", "urban", "desert", "arctic", "jungle", "forest"]).toContain(state.themeId);
  });

  it("creates a recoverable objective at the UFO power source", () => {
    const state = createSkirmish({ seed: 1234 });

    expect(state.objective).toMatchObject({
      kind: "recover",
      label: "Recover UFO power source",
      recovered: false,
      extracted: false,
    });
    expect(state.objective).toBeDefined();
    if (!state.objective) return;
    expect(tileTypeAt(state.grid, state.objective.target.x, state.objective.target.y)?.id).toBe("ufo_power");
    expect(state.objective.extractionZone.length).toBeGreaterThan(0);
    for (const tile of state.objective.extractionZone) {
      expect(blocksMove(state.grid, tile.x, tile.y)).toBe(false);
    }
    expect(state.objective.extractionZone.some((tile) => tileTypeAt(state.grid, tile.x, tile.y)?.id === "dropship_floor")).toBe(true);
  });

  it("honours an explicit terrain theme", () => {
    const state = createSkirmish({ seed: 1234, themeId: "desert" });
    expect(state.themeId).toBe("desert");
  });

  it("clamps squad counts to the available spawns and logs the shortfall", () => {
    // Far more units than any map can host => counts clamp, no overlaps.
    const state = createSkirmish({ seed: 5, players: 50, enemies: 50 });
    const seen = new Set(state.units.map((u) => `${u.pos.x},${u.pos.y}`));
    expect(seen.size).toBe(state.units.length);
    expect(state.units.length).toBeLessThan(100);
    expect(state.log.some((line) => line.includes("available"))).toBe(true);
  });

  it("assigns ids 1..N and unique names", () => {
    const state = createSkirmish({ seed: 7, players: 3, enemies: 2 });
    const ids = state.units.map((u) => u.id).sort((a, b) => a - b);
    expect(ids).toEqual([1, 2, 3, 4, 5]);
    const names = new Set(state.units.map((u) => u.name));
    expect(names.size).toBe(state.units.length);
  });

  it("initialises battle bookkeeping and seeds the player fog", () => {
    const state = createSkirmish({ seed: 99 });
    expect(state.turn).toBe(1);
    expect(state.activeFaction).toBe("player");
    expect(state.status).toBe("playing");
    expect(state.explored.size).toBeGreaterThan(0);
    expect(state.weapons.rifle).toBeDefined();
  });

  it("can override player weapon loadouts for campaign unlocks", () => {
    const state = createSkirmish({
      seed: 99,
      players: 4,
      enemies: 1,
      playerWeaponIds: ["plasma", "rifle", "pistol", "unknown"],
    });
    const players = state.units.filter((unit) => unit.faction === "player");

    expect(players.map((unit) => unit.weaponId)).toEqual(["plasma", "rifle", "pistol", "rifle"]);
    expect(players.map((unit) => unit.ammo)).toEqual([
      WEAPONS.plasma!.magazineSize,
      WEAPONS.rifle!.magazineSize,
      WEAPONS.pistol!.magazineSize,
      WEAPONS.rifle!.magazineSize,
    ]);
  });

  it("can deploy named campaign soldiers", () => {
    const state = createSkirmish({
      seed: 99,
      players: 2,
      enemies: 1,
      playerNames: ["Vega", "Rook"],
      playerSoldierIds: ["soldier-01", "soldier-02"],
      playerStatBonuses: [
        { timeUnits: 2, health: 2, reactions: 4, firingAccuracy: 4 },
        { timeUnits: 6, health: 8, reactions: 10, firingAccuracy: 12 },
      ],
    });
    const players = state.units.filter((unit) => unit.faction === "player");

    expect(players.map((unit) => unit.name)).toEqual(["Vega", "Rook"]);
    expect(players.map((unit) => unit.campaignSoldierId)).toEqual(["soldier-01", "soldier-02"]);
    expect(players[0]?.stats.timeUnits).toBe(62);
    expect(players[0]?.stats.health).toBe(42);
    expect(players[0]?.stats.firingAccuracy).toBe(69);
    expect(players[1]?.stats.timeUnits).toBe(66);
    expect(players[1]?.stats.health).toBe(48);
    expect(players[1]?.stats.reactions).toBe(60);
  });

  it("is deterministic: same seed => identical map and units", () => {
    const a = createSkirmish({ seed: 424242 });
    const b = createSkirmish({ seed: 424242 });
    expect(Array.from(a.grid.cells)).toEqual(Array.from(b.grid.cells));
    expect(a.themeId).toBe(b.themeId);
    expect(a.units).toEqual(b.units);
    expect(a.rng.state).toBe(b.rng.state);
  });
});
