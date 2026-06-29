import { describe, it, expect } from "vitest";
import { Rng } from "../src/sim/rng";
import {
  DEFAULT_PALETTE,
  DEBRIS_TILE,
  LOW_COVER,
  makeGrid,
  setTile,
  tileTypeAt,
  blocksMove,
  blocksSight,
  moveCost,
  destroyCoverAt,
  ensureDebrisIndex,
} from "../src/sim/grid";
import { applyCommand } from "../src/sim/battle";
import { ITEMS, WEAPONS } from "../src/sim/content";
import { TILES } from "../src/sim/terrain";
import { MORALE } from "../src/sim/types";
import type {
  BattleState,
  Dir8,
  Faction,
  ItemInstance,
  TileType,
  Unit,
  UnitId,
  Vec2,
} from "../src/sim/types";

// ---------------------------------------------------------------------------
// Test palette + factories. Mirrors tests/tactical-items.test.ts but builds the
// grid from the terrain TILES catalogue so real cover (sandbags / low_wall /
// crate / rock) can be placed at known offsets from a blast center.
// ---------------------------------------------------------------------------

const PALETTE: TileType[] = [
  TILES.grass, // 0
  TILES.sandbags, // 1 — half cover, blocksMove, destructible
  TILES.low_wall, // 2 — full shoot-over cover, blocksMove, destructible
  TILES.crate, // 3 — half cover, blocksMove, destructible
  TILES.rock, // 4 — full cover, blocksMove, INDESTRUCTIBLE
];
const GRASS = 0;
const SANDBAGS = 1;
const LOW_WALL = 2;
const CRATE = 3;
const ROCK = 4;

function makeCoverGrid(width = 30, height = 30): BattleState["grid"] {
  // Pass a FRESH copy: makeGrid stores the palette by reference, and
  // destroyCoverAt appends a "debris" entry to it — so a shared constant palette
  // would leak across tests (and across grids).
  return makeGrid(width, height, PALETTE.slice(), GRASS);
}

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

function grenade(uses = 1): ItemInstance {
  return { itemId: "grenade", uses };
}

/** A far-away, unarmed enemy so a grenade throw does not end the battle
 *  (checkVictory ends the game when no enemies remain). It never reaches the
 *  action and carries no grenade, so it cannot alter any tile. */
function farEnemy(): Unit {
  return makeUnit(900, "enemy", { x: 29, y: 29 }, 4, { ammo: 0, items: [] });
}

function makeState(units: Unit[], grid?: BattleState["grid"], seed = 1234): BattleState {
  return {
    grid: grid ?? makeCoverGrid(),
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
// destroyCoverAt (grid-layer primitive)
// ---------------------------------------------------------------------------

describe("destroyCoverAt", () => {
  it("flattens a destructible cover tile to a walkable, no-cover debris tile", () => {
    const g = makeCoverGrid();
    setTile(g, 5, 5, SANDBAGS);
    expect(destroyCoverAt(g, 5, 5)).toBe(true);

    const tile = tileTypeAt(g, 5, 5);
    expect(tile?.id).toBe("debris");
    expect(tile?.cover).toBe(0);
    expect(tile?.blocksMove).toBe(false);
    expect(tile?.blocksSight).toBe(false);
    expect(tile?.destructible).toBe(false);
    expect(tile?.render).toBe("rubble");
    // The former obstacle is now walkable.
    expect(blocksMove(g, 5, 5)).toBe(false);
    expect(Number.isFinite(moveCost(g, 5, 5))).toBe(true);
  });

  it("leaves indestructible cover (rock) untouched", () => {
    const g = makeCoverGrid();
    setTile(g, 5, 5, ROCK);
    expect(destroyCoverAt(g, 5, 5)).toBe(false);
    expect(tileTypeAt(g, 5, 5)?.id).toBe("rock");
    expect(blocksMove(g, 5, 5)).toBe(true);
  });

  it("leaves plain ground (cover 0) untouched", () => {
    const g = makeCoverGrid();
    expect(destroyCoverAt(g, 5, 5)).toBe(false);
    expect(tileTypeAt(g, 5, 5)?.id).toBe("grass");
  });

  it("is a no-op out of bounds and does not grow the palette", () => {
    const g = makeCoverGrid();
    const before = g.palette.length;
    expect(destroyCoverAt(g, -1, 0)).toBe(false);
    expect(destroyCoverAt(g, 99, 99)).toBe(false);
    expect(g.palette.length).toBe(before);
  });

  it("appends the debris tile to the palette exactly once across many destroys", () => {
    const g = makeCoverGrid();
    const before = g.palette.length;
    setTile(g, 1, 1, SANDBAGS);
    setTile(g, 2, 2, LOW_WALL);
    setTile(g, 3, 3, CRATE);

    destroyCoverAt(g, 1, 1);
    const firstDebrisIndex = g.cells[1 * g.width + 1]!;
    expect(g.palette.length).toBe(before + 1);
    expect(g.palette[firstDebrisIndex]).toBe(DEBRIS_TILE);

    // Subsequent destroys reuse the same palette entry (no further growth).
    destroyCoverAt(g, 2, 2);
    destroyCoverAt(g, 3, 3);
    expect(g.palette.length).toBe(before + 1);
    expect(g.cells[2 * g.width + 2]).toBe(firstDebrisIndex);
    expect(g.cells[3 * g.width + 3]).toBe(firstDebrisIndex);
  });

  it("ensureDebrisIndex is idempotent and returns the same index per palette", () => {
    const pal: TileType[] = [...PALETTE];
    const a = ensureDebrisIndex(pal);
    const b = ensureDebrisIndex(pal);
    expect(a).toBe(b);
    expect(pal[a]).toBe(DEBRIS_TILE);
  });

  it("works on a bare DEFAULT_PALETTE grid (no debris tile listed up front)", () => {
    const g = makeGrid(4, 4, DEFAULT_PALETTE.slice(), LOW_COVER);
    expect(destroyCoverAt(g, 1, 1)).toBe(true);
    expect(tileTypeAt(g, 1, 1)?.id).toBe("debris");
    expect(blocksMove(g, 1, 1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Blast destroys cover (thrown grenade via applyCommand)
// ---------------------------------------------------------------------------

describe("grenade blast destroys cover", () => {
  it("destroys every destructible cover tile in radius and leaves the rest intact", () => {
    const g = makeCoverGrid();
    const center: Vec2 = { x: 10, y: 10 };
    // In-radius destructible cover at a few offsets.
    setTile(g, 10, 10, SANDBAGS); // dist 0 (center)
    setTile(g, 11, 10, LOW_WALL); // dist 1
    setTile(g, 10, 12, CRATE); // dist 2
    setTile(g, 12, 12, SANDBAGS); // dist 2 (diagonal)
    setTile(g, 12, 10, ROCK); // dist 2 but INDESTRUCTIBLE -> survives
    setTile(g, 13, 10, SANDBAGS); // dist 3 -> OUTSIDE radius, survives

    const thrower = makeUnit(1, "player", { x: 10, y: 6 }, 4, {
      items: [grenade()],
      hp: 200,
      stats: { timeUnits: 60, health: 200, reactions: 40, firingAccuracy: 60, strength: 30, bravery: 50 },
    });
    const state = makeState([thrower, farEnemy()], g);

    const events = applyCommand(state, {
      type: "throwItem",
      unitId: 1,
      target: center,
      itemId: "grenade",
    });

    // A blast detonated.
    expect(events.some((e) => e.type === "blastDetonated")).toBe(true);

    // Every in-radius destructible cover tile is now walkable debris (cover 0).
    for (const [x, y] of [
      [10, 10],
      [11, 10],
      [10, 12],
      [12, 12],
    ] as const) {
      const tile = tileTypeAt(g, x, y);
      expect(tile?.id, `${x},${y}`).toBe("debris");
      expect(tile?.cover, `${x},${y}`).toBe(0);
      expect(blocksMove(g, x, y), `${x},${y}`).toBe(false);
    }

    // Indestructible rock inside the blast survived.
    expect(tileTypeAt(g, 12, 10)?.id).toBe("rock");
    expect(blocksMove(g, 12, 10)).toBe(true);

    // Cover outside the blast radius is untouched.
    expect(tileTypeAt(g, 13, 10)?.id).toBe("sandbags");
    expect(tileTypeAt(g, 13, 10)?.cover).toBe(1);
    expect(blocksMove(g, 13, 10)).toBe(true);
  });

  it("is deterministic: identical state + throw => identical destroyed cells", () => {
    function run(): Uint16Array {
      const g = makeCoverGrid();
      setTile(g, 10, 10, SANDBAGS);
      setTile(g, 11, 10, CRATE);
      setTile(g, 13, 10, LOW_WALL); // outside radius 2
      const thrower = makeUnit(1, "player", { x: 10, y: 6 }, 4, { items: [grenade()] });
      const state = makeState([thrower, farEnemy()], g, 999);
      applyCommand(state, { type: "throwItem", unitId: 1, target: { x: 10, y: 10 }, itemId: "grenade" });
      return state.grid.cells.slice();
    }
    expect(Array.from(run())).toEqual(Array.from(run()));
  });
});

// ---------------------------------------------------------------------------
// Units can move through destroyed cover
// ---------------------------------------------------------------------------

describe("moving through destroyed cover", () => {
  it("a blocksMove cover tile becomes a valid move destination once blasted", () => {
    const g = makeCoverGrid();
    setTile(g, 5, 6, SANDBAGS); // blocks the mover's destination
    const mover = makeUnit(1, "player", { x: 5, y: 5 }, 4, {
      hp: 200,
      stats: { timeUnits: 60, health: 200, reactions: 40, firingAccuracy: 60, strength: 30, bravery: 50 },
    });
    const thrower = makeUnit(2, "player", { x: 9, y: 6 }, 6, { items: [grenade()] });
    const state = makeState([mover, thrower, farEnemy()], g);

    // Before: the sandbags tile blocks movement, so the mover cannot enter it.
    const blocked = applyCommand(state, { type: "move", unitId: 1, to: { x: 5, y: 6 } });
    expect(blocked.some((e) => e.type === "blocked")).toBe(true);
    expect(state.units[0]!.pos).toEqual({ x: 5, y: 5 });

    // Blow up the cover with a grenade thrown from outside the mover's tile.
    applyCommand(state, { type: "throwItem", unitId: 2, target: { x: 5, y: 6 }, itemId: "grenade" });
    expect(tileTypeAt(g, 5, 6)?.id).toBe("debris");
    expect(blocksMove(g, 5, 6)).toBe(false);

    // After: the mover can step onto the former obstacle.
    const moved = applyCommand(state, { type: "move", unitId: 1, to: { x: 5, y: 6 } });
    expect(moved.some((e) => e.type === "moveStep")).toBe(true);
    expect(state.units[0]!.pos).toEqual({ x: 5, y: 6 });
    expect(state.units[0]!.alive).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Primed detonation (the other blast path) also destroys cover — proves the
// rule applies to alien grenades / blast damage in general, not just throws.
// ---------------------------------------------------------------------------

describe("primed grenade detonation destroys cover", () => {
  it("a primed grenade blowing up on its carrier destroys adjacent cover", () => {
    const g = makeCoverGrid();
    setTile(g, 6, 5, SANDBAGS); // adjacent to the carrier, within blast radius 2
    // Seal a harmless enemy inside a rock box so it cannot alter any tile or
    // end the battle, keeping the round deterministic.
    for (const [x, y] of [
      [19, 19],
      [20, 19],
      [21, 19],
      [19, 20],
      [21, 20],
      [19, 21],
      [20, 21],
      [21, 21],
    ] as const) {
      setTile(g, x, y, ROCK);
    }

    const carrier = makeUnit(1, "player", { x: 5, y: 5 }, 0, {
      items: [grenade()],
      hp: 200,
      stats: { timeUnits: 60, health: 200, reactions: 40, firingAccuracy: 60, strength: 30, bravery: 50 },
    });
    const enemy = makeUnit(2, "enemy", { x: 20, y: 20 }, 4); // boxed in, no grenade
    const state = makeState([carrier, enemy], g, 4242);

    // Prime a 1-fuse grenade, then end the turn. After the enemy turn a new
    // round begins; at the start of the player's turn the grenade detonates on
    // its carrier and destroys the adjacent cover.
    applyCommand(state, { type: "primeItem", unitId: 1, itemId: "grenade", fuseTurns: 1 });
    applyCommand(state, { type: "endTurn" });

    expect(tileTypeAt(g, 6, 5)?.id).toBe("debris");
    expect(tileTypeAt(g, 6, 5)?.cover).toBe(0);
    expect(blocksMove(g, 6, 5)).toBe(false);
  });
});
