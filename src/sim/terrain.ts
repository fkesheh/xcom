/**
 * Terrain CONTENT + the render-category contract for the battlescape.
 *
 * This module is PURE DATA + tiny pure helpers — no three.js, no DOM, no
 * Math.random, no Date. Same inputs => same outputs, so the seeded generator
 * that consumes it stays deterministic.
 *
 * Three layers live here:
 *  1. {@link TILES} — a catalogue of reusable {@link TileType} entries. Every
 *     entry carries a `render` category (see {@link RENDER_CATEGORIES}) that the
 *     renderer maps to a concrete look. Tactical flags are deliberate, e.g.
 *     fence/window block MOVEMENT but NOT sight (you shoot over/through them, so
 *     the corner-peek line-of-fire model matters), while hedge/bush block SIGHT
 *     but are WALKABLE (concealment you can stand in).
 *  2. {@link THEMES} — handcrafted {@link TerrainTheme}s (farmland / urban /
 *     desert). Each theme owns a `palette` (index 0 is its dominant walkable
 *     ground, so a blank/edge fills sanely) and a set of {@link TerrainBlock}s:
 *     ~10x10 ASCII tiles drawn with the shared {@link CHAR_TO_ID} legend.
 *  3. PREFABS — the classic recoverable {@link UFO_PREFAB} saucer and the
 *     squad's {@link DROPSHIP_PREFAB}, plus {@link PREFAB_TILES} the generator
 *     appends to a theme palette and the helpers to read any block's cells.
 *
 * Generator integration (see integrationNotes): pick a theme with
 * {@link getTheme}/{@link themeIds}; build the grid palette with
 * {@link appendPrefabTiles}; build a char->index {@link Legend} once with
 * {@link buildLegend}; then stamp blocks/prefabs cell-by-cell via
 * {@link blockCell}.
 */

import type { TileType } from "./types";

// ---------------------------------------------------------------------------
// Tile catalogue
// ---------------------------------------------------------------------------

/** Identity helper: contextually types literal flags, returns a plain TileType. */
function tile(t: TileType): TileType {
  return t;
}

/**
 * Reusable tile types, keyed by stable id. Themes compose their palettes from
 * these. `render` is the presentation category (the renderer must handle each
 * distinct value — see {@link RENDER_CATEGORIES}).
 *
 * Tactical flag conventions:
 *  - WALKABLE OPEN (cover 0): plain ground / floors / roads.
 *  - PARTIAL COVER (cover 1): fence + window block move, NOT sight (shoot
 *    over/through); crate + barrel + sandbags block move, NOT sight; rubble +
 *    hedge + bush are walkable; hedge/bush block SIGHT (concealment).
 *  - LOW FULL COVER (cover 2): low_wall blocks move but NOT sight — full cover
 *    you can still fire OVER (a concrete barrier / field wall).
 *  - FULL COVER / BLOCKERS (cover 2): walls / rock / tree / hulls block move AND
 *    sight.
 *  - OPENINGS: door / ufo_door are walkable and do NOT block sight.
 */
export const TILES = {
  // -- Walkable open ground / floors (cover 0) -----------------------------
  grass: tile({
    id: "grass", label: "Grass", render: "grass",
    blocksMove: false, blocksSight: false, moveCost: 4, cover: 0, destructible: false,
  }),
  soil: tile({
    id: "soil", label: "Tilled Soil", render: "soil",
    blocksMove: false, blocksSight: false, moveCost: 4, cover: 0, destructible: false,
  }),
  crop: tile({
    id: "crop", label: "Crop Field", render: "crop",
    blocksMove: false, blocksSight: false, moveCost: 5, cover: 0, destructible: true,
  }),
  road: tile({
    id: "road", label: "Dirt Road", render: "road",
    blocksMove: false, blocksSight: false, moveCost: 3, cover: 0, destructible: false,
  }),
  pavement: tile({
    id: "pavement", label: "Pavement", render: "pavement",
    blocksMove: false, blocksSight: false, moveCost: 3, cover: 0, destructible: false,
  }),
  sand: tile({
    id: "sand", label: "Sand", render: "sand",
    blocksMove: false, blocksSight: false, moveCost: 5, cover: 0, destructible: false,
  }),
  floor_wood: tile({
    id: "floor_wood", label: "Wood Floor", render: "floor_wood",
    blocksMove: false, blocksSight: false, moveCost: 4, cover: 0, destructible: false,
  }),
  floor_concrete: tile({
    id: "floor_concrete", label: "Concrete Floor", render: "floor_concrete",
    blocksMove: false, blocksSight: false, moveCost: 4, cover: 0, destructible: false,
  }),
  ufo_floor: tile({
    id: "ufo_floor", label: "Alien Deck", render: "ufo_floor",
    blocksMove: false, blocksSight: false, moveCost: 4, cover: 0, destructible: false,
  }),
  dropship_floor: tile({
    id: "dropship_floor", label: "Dropship Deck", render: "dropship_floor",
    blocksMove: false, blocksSight: false, moveCost: 4, cover: 0, destructible: false,
  }),

  // -- Partial cover (cover 1) ---------------------------------------------
  // Block movement but NOT sight: the peek/over-cover fire model shines here.
  fence: tile({
    id: "fence", label: "Fence", render: "fence",
    blocksMove: true, blocksSight: false, moveCost: 0, cover: 1, destructible: true,
  }),
  window: tile({
    id: "window", label: "Window", render: "window",
    blocksMove: true, blocksSight: false, moveCost: 0, cover: 1, destructible: true,
  }),
  crate: tile({
    id: "crate", label: "Crate", render: "crate",
    blocksMove: true, blocksSight: false, moveCost: 0, cover: 1, destructible: true,
  }),
  barrel: tile({
    id: "barrel", label: "Barrel", render: "barrel",
    blocksMove: true, blocksSight: false, moveCost: 0, cover: 1, destructible: true,
  }),
  // Sandbag emplacement: half cover that blocks movement but NOT sight. A
  // universal defensive prop the generator scatters as tactical cover.
  sandbags: tile({
    id: "sandbags", label: "Sandbags", render: "sandbags",
    blocksMove: true, blocksSight: false, moveCost: 0, cover: 1, destructible: true,
  }),
  // Walkable difficult terrain that still grants partial cover.
  rubble: tile({
    id: "rubble", label: "Rubble", render: "rubble",
    blocksMove: false, blocksSight: false, moveCost: 6, cover: 1, destructible: false,
  }),
  // Walkable concealment: blocks SIGHT but not movement.
  hedge: tile({
    id: "hedge", label: "Hedge", render: "hedge",
    blocksMove: false, blocksSight: true, moveCost: 6, cover: 1, destructible: true,
  }),
  bush: tile({
    id: "bush", label: "Bush", render: "bush",
    blocksMove: false, blocksSight: true, moveCost: 5, cover: 1, destructible: true,
  }),

  // -- Low full cover / shoot-over (cover 2): block move, NOT sight --------
  // A low wall / concrete barrier: grants FULL cover and can't be entered, yet
  // can be fired OVER (blocksSight false). Distinct from the sight-blocking
  // walls below, which fully occlude line of fire as well as movement.
  low_wall: tile({
    id: "low_wall", label: "Low Wall", render: "low_wall",
    blocksMove: true, blocksSight: false, moveCost: 0, cover: 2, destructible: true,
  }),

  // -- Full cover / blockers (cover 2): block move AND sight ---------------
  wall_building: tile({
    id: "wall_building", label: "Building Wall", render: "wall_building",
    blocksMove: true, blocksSight: true, moveCost: 0, cover: 2, destructible: true,
  }),
  wall_interior: tile({
    id: "wall_interior", label: "Interior Wall", render: "wall_interior",
    blocksMove: true, blocksSight: true, moveCost: 0, cover: 2, destructible: true,
  }),
  rock: tile({
    id: "rock", label: "Rock", render: "rock",
    blocksMove: true, blocksSight: true, moveCost: 0, cover: 2, destructible: false,
  }),
  tree: tile({
    id: "tree", label: "Tree", render: "tree",
    blocksMove: true, blocksSight: true, moveCost: 0, cover: 2, destructible: true,
  }),
  ufo_hull: tile({
    id: "ufo_hull", label: "UFO Hull", render: "ufo_hull",
    blocksMove: true, blocksSight: true, moveCost: 0, cover: 2, destructible: false,
  }),
  dropship_hull: tile({
    id: "dropship_hull", label: "Dropship Hull", render: "dropship_hull",
    blocksMove: true, blocksSight: true, moveCost: 0, cover: 2, destructible: false,
  }),
  // Recoverable "power source" flavour pillar — distinct identity, reuses the
  // ufo_hull visual so the renderer needs no extra category.
  ufo_power: tile({
    id: "ufo_power", label: "Power Source", render: "ufo_hull",
    blocksMove: true, blocksSight: true, moveCost: 0, cover: 2, destructible: false,
  }),

  // -- Openings & special ---------------------------------------------------
  door: tile({
    id: "door", label: "Doorway", render: "door",
    blocksMove: false, blocksSight: false, moveCost: 4, cover: 0, destructible: true,
  }),
  ufo_door: tile({
    id: "ufo_door", label: "UFO Hatch", render: "ufo_door",
    blocksMove: false, blocksSight: false, moveCost: 4, cover: 0, destructible: false,
  }),
} satisfies Record<string, TileType>;

/**
 * Every distinct `render` category produced by {@link TILES} (and therefore by
 * all themes + prefabs). The renderer MUST handle each of these. `ufo_power`
 * intentionally reuses "ufo_hull", so it is NOT a separate category.
 */
export const RENDER_CATEGORIES: readonly string[] = [
  // walkable open
  "grass", "soil", "crop", "road", "pavement", "sand",
  "floor_wood", "floor_concrete", "ufo_floor", "dropship_floor",
  // partial cover
  "fence", "window", "crate", "barrel", "sandbags", "rubble", "hedge", "bush",
  // low full cover / shoot-over
  "low_wall",
  // full cover / blockers
  "wall_building", "wall_interior", "rock", "tree", "ufo_hull", "dropship_hull",
  // openings
  "door", "ufo_door",
];

// ---------------------------------------------------------------------------
// Theme + block model
// ---------------------------------------------------------------------------

/** A char->palette-index map for one (theme or combined) palette. */
export type Legend = Record<string, number>;

/** A handcrafted chunk of map drawn as ASCII art (rows.length === h, each row length === w). */
export interface TerrainBlock {
  id: string;
  w: number;
  h: number;
  /** ASCII rows; each char resolves through a {@link Legend} to a palette index. */
  rows: string[];
}

/** A terrain theme: a palette (index 0 = dominant walkable ground) + blocks. */
export interface TerrainTheme {
  id: string;
  name: string;
  palette: TileType[];
  blocks: TerrainBlock[];
  /**
   * Special themes are resolvable by {@link getTheme} (explicit request) but
   * excluded from {@link themeIds}' random-pick pool, so a normal mission never
   * rolls them by chance. Used by the alien-base assault, whose tileset is an
   * explicit story beat rather than a natural terrain.
   */
  special?: boolean;
}

/** Palette index of the dominant walkable ground in every theme palette. */
export const GROUND_INDEX = 0;

/**
 * Shared ASCII legend: char -> tile id. The generator never uses this map
 * directly — it builds a char->index {@link Legend} for a concrete palette with
 * {@link buildLegend}. '.' and ' ' are reserved by {@link buildLegend} to mean
 * "dominant ground" (palette index {@link GROUND_INDEX}) and are NOT listed here.
 */
export const CHAR_TO_ID: Record<string, string> = {
  // walkable ground / floors
  g: "grass",
  d: "soil",
  c: "crop",
  r: "road",
  p: "pavement",
  s: "sand",
  W: "floor_wood",
  O: "floor_concrete",
  U: "ufo_floor",
  D: "dropship_floor",
  // partial cover
  f: "fence",
  n: "window",
  x: "crate",
  b: "barrel",
  u: "rubble",
  h: "hedge",
  v: "bush",
  // full cover / blockers
  "#": "wall_building",
  "%": "wall_interior",
  R: "rock",
  T: "tree",
  H: "ufo_hull",
  S: "dropship_hull",
  P: "ufo_power",
  // openings / special
  "+": "door",
  "*": "ufo_door",
};

/** Build a {@link TerrainBlock}, deriving w/h from the rows (w = first row length). */
function block(id: string, rows: string[]): TerrainBlock {
  return { id, w: rows[0]?.length ?? 0, h: rows.length, rows };
}

// ---------------------------------------------------------------------------
// Pure read helpers
// ---------------------------------------------------------------------------

/**
 * Build a char->palette-index {@link Legend} for `palette`. '.' and ' ' map to
 * {@link GROUND_INDEX}; every {@link CHAR_TO_ID} char whose tile id is present
 * in `palette` maps to that tile's index. Chars whose tile is absent are
 * omitted (they fall back to ground in {@link blockCell}). Deterministic.
 */
export function buildLegend(palette: TileType[]): Legend {
  const legend: Legend = { ".": GROUND_INDEX, " ": GROUND_INDEX };
  for (const char of Object.keys(CHAR_TO_ID)) {
    const id = CHAR_TO_ID[char];
    if (id === undefined) continue;
    const idx = palette.findIndex((t) => t.id === id);
    if (idx >= 0) legend[char] = idx;
  }
  return legend;
}

/** First palette index whose tile id === `id`, or -1 when absent. */
export function paletteIndexById(palette: TileType[], id: string): number {
  return palette.findIndex((t) => t.id === id);
}

/** First palette index whose tile `render` category === `render`, or -1. */
export function paletteIndexByRender(palette: TileType[], render: string): number {
  return palette.findIndex((t) => t.render === render);
}

/**
 * Resolve the palette index for block-local cell (lx, ly) via `legend`.
 * Out-of-range cells and unknown chars resolve to {@link GROUND_INDEX}, so a
 * block can be smaller than the region it fills without crashing the generator.
 * Works for theme blocks AND prefabs (build the legend from the combined
 * palette returned by {@link appendPrefabTiles}).
 */
export function blockCell(block: TerrainBlock, legend: Legend, lx: number, ly: number): number {
  const row = block.rows[ly];
  if (row === undefined) return GROUND_INDEX;
  const char = row.charAt(lx);
  if (char === "") return GROUND_INDEX;
  return legend[char] ?? GROUND_INDEX;
}

/**
 * Combine a theme palette with the prefab tile types (UFO + dropship), appending
 * any not already present (deduped by id) WITHOUT mutating the input. The result
 * is the palette the generator should hand to the {@link Grid}; pair it with
 * {@link buildLegend} so prefab chars (U/D/H/S/P/*) resolve.
 */
export function appendPrefabTiles(palette: TileType[]): TileType[] {
  const out = [...palette];
  for (const t of PREFAB_TILES) {
    if (!out.some((p) => p.id === t.id)) out.push(t);
  }
  return out;
}

/** True when every row of `block` has length === block.w and there are block.h rows. */
export function validateBlock(block: TerrainBlock): boolean {
  if (block.rows.length !== block.h) return false;
  return block.rows.every((r) => r.length === block.w);
}

// ---------------------------------------------------------------------------
// Theme: FARMLAND (rural crash site)
// ---------------------------------------------------------------------------

const FARMLAND_PALETTE: TileType[] = [
  TILES.grass, // 0 — dominant ground
  TILES.soil,
  TILES.crop,
  TILES.road,
  TILES.floor_wood,
  TILES.fence,
  TILES.window,
  TILES.door,
  TILES.hedge,
  TILES.bush,
  TILES.crate,
  TILES.barrel,
  TILES.rubble,
  TILES.wall_building,
  TILES.wall_interior,
  TILES.tree,
  TILES.rock,
  TILES.sandbags,
  TILES.low_wall,
];

const FARMLAND_BLOCKS: TerrainBlock[] = [
  // Open crop field with a lone tree and a bush.
  block("farm_field", [
    "gggggggggg",
    "gccccccccg",
    "gccccccccg",
    "gccccccccg",
    "gccccccccg",
    "gccccccccg",
    "gccccccccg",
    "ggggvggggg",
    "ggggggTggg",
    "gggggggggg",
  ]),
  // Fenced paddock with a gate gap and a dirt path along the bottom.
  block("farm_paddock", [
    "gggggggggg",
    "gffffffffg",
    "gf      fg",
    "gf      fg",
    "gf      fg",
    "gfff ffffg",
    "gg      gg",
    "gggddddggg",
    "gggddddggg",
    "gggggggggg",
  ]),
  // Farmhouse: wood walls + interior wall, windows to shoot through, a door.
  block("farm_house", [
    "gggggggggg",
    "g########g",
    "g#WWWWWW#g",
    "g#WW%WWn#g",
    "g#WW%WWW#g",
    "g#WW%nWW#g",
    "g#WWWWWW#g",
    "g###++###g",
    "ggggddgggg",
    "gggggggggg",
  ]),
  // Crossroads of dirt roads lined with trees and hedges (roads meet the edges
  // so blocks stitch along their road lanes).
  block("farm_crossroad", [
    "ggggrrgggg",
    "ggggrrgggg",
    "TgghrrhggT",
    "gghhrrhhgg",
    "ggggrrgggg",
    "rrrrrrrrrr",
    "rrrrrrrrrr",
    "ggggrrgggg",
    "TgghrrhggT",
    "ggggrrgggg",
  ]),
];

export const FARMLAND: TerrainTheme = {
  id: "farmland",
  name: "Farmland",
  palette: FARMLAND_PALETTE,
  blocks: FARMLAND_BLOCKS,
};

// ---------------------------------------------------------------------------
// Theme: URBAN (city block)
// ---------------------------------------------------------------------------

const URBAN_PALETTE: TileType[] = [
  TILES.pavement, // 0 — dominant ground
  TILES.road,
  TILES.floor_concrete,
  TILES.grass,
  TILES.fence,
  TILES.window,
  TILES.door,
  TILES.hedge,
  TILES.bush,
  TILES.crate,
  TILES.barrel,
  TILES.rubble,
  TILES.wall_building,
  TILES.wall_interior,
  TILES.tree,
  TILES.sandbags,
  TILES.low_wall,
];

const URBAN_BLOCKS: TerrainBlock[] = [
  // Street: a road lane between pavement sidewalks dotted with trees/crates.
  block("urban_street", [
    "ppprrrrppp",
    "pTprrrrpvp",
    "ppprrrrppp",
    "pxprrrrpTp",
    "ppprrrrppp",
    "ppprrrrppp",
    "pvprrrrpxp",
    "ppprrrrppp",
    "pTprrrrpvp",
    "ppprrrrppp",
  ]),
  // Two-room concrete office: windowed exterior walls, an interior door, and a
  // double entrance at the bottom.
  block("urban_office", [
    "##nn##nn##",
    "#OOOO%OOO#",
    "nOOOO%OOOn",
    "#OOOO+OOO#",
    "#OOOO%OOO#",
    "nOOOO%OOOn",
    "#OOOO%OOO#",
    "nOOOO%OOOn",
    "#OOOO%OOO#",
    "####++####",
  ]),
  // Plaza: open pavement with hedges, a planted tree, and benches.
  block("urban_plaza", [
    "pppppppppp",
    "phhpppphhp",
    "ppppTppppp",
    "pppppppppp",
    "pppppppppp",
    "ppppppxppp",
    "pTpppppppp",
    "phpppppphp",
    "pppppppvpp",
    "pppppppppp",
  ]),
  // Fenced vacant lot: rubble, crates and a barrel, with gaps in the fence to
  // enter from the streets above/below.
  block("urban_lot", [
    "ffff  ffff",
    "f        f",
    "f  uu    f",
    "f  uu  x f",
    "f        f",
    "f x   bb f",
    "f        f",
    "f   uu   f",
    "f        f",
    "ffff  ffff",
  ]),
];

export const URBAN: TerrainTheme = {
  id: "urban",
  name: "Urban",
  palette: URBAN_PALETTE,
  blocks: URBAN_BLOCKS,
};

// ---------------------------------------------------------------------------
// Theme: DESERT (rocky)
// ---------------------------------------------------------------------------

const DESERT_PALETTE: TileType[] = [
  TILES.sand, // 0 — dominant ground
  TILES.soil,
  TILES.road,
  TILES.floor_concrete,
  TILES.fence,
  TILES.window,
  TILES.door,
  TILES.bush,
  TILES.rubble,
  TILES.crate,
  TILES.wall_building,
  TILES.wall_interior,
  TILES.tree,
  TILES.rock,
  TILES.sandbags,
  TILES.low_wall,
];

const DESERT_BLOCKS: TerrainBlock[] = [
  // Open dunes with scattered scrub bushes and a couple of rocks.
  block("desert_dunes", [
    "ssssssssss",
    "sssvssssss",
    "ssssssRsss",
    "ssssssssss",
    "ssvsssssvs",
    "ssssssssss",
    "ssssRsssss",
    "ssssssssss",
    "svssssssss",
    "ssssssssss",
  ]),
  // Rock outcrops with rubble at their feet and a sand path down the middle.
  block("desert_rocks", [
    "ssssssssss",
    "sRRRssRRRs",
    "sRRRssRRRs",
    "ssuRssRuss",
    "ssssssssss",
    "sRRssssRRs",
    "sRRsvvssRs",
    "ssuRsssRus",
    "ssssssssss",
    "ssssssssss",
  ]),
  // Small ruin: concrete walls part-collapsed to rubble, a window and a door.
  block("desert_ruin", [
    "ssssssssss",
    "ss#####sss",
    "ss#OOO#sss",
    "ssnOOO#sss",
    "ss+OOO#sss",
    "ss#OOOusss",
    "ss##u##sss",
    "sssuusssss",
    "ssssssssss",
    "ssssssssss",
  ]),
  // Scrub basin: open sand fringed by scrub and a rock.
  block("desert_basin", [
    "ssssssssss",
    "ssssvsssss",
    "ssssssssss",
    "ssssssssss",
    "ssssssssss",
    "ssssssRsss",
    "ssssssssss",
    "svsssssvss",
    "ssssssssss",
    "ssssssssss",
  ]),
];

export const DESERT: TerrainTheme = {
  id: "desert",
  name: "Desert",
  palette: DESERT_PALETTE,
  blocks: DESERT_BLOCKS,
};

// ---------------------------------------------------------------------------
// Theme registry
// ---------------------------------------------------------------------------

/**
 * The alien-base assault tileset. Currently aliases the urban layout (enclosed
 * blocks read well for an interior HQ); the game layer forces deep-night lighting
 * and the HUD labels it "Alien Base". Marked `special` so it is only used when
 * explicitly requested by the assault operation — never a random mission theme.
 */
export const ALIEN_BASE: TerrainTheme = {
  id: "alienBase",
  name: "Alien Base",
  palette: URBAN_PALETTE,
  blocks: URBAN_BLOCKS,
  special: true,
};

/** All terrain themes, keyed by id. */
export const THEMES: Record<string, TerrainTheme> = {
  farmland: FARMLAND,
  urban: URBAN,
  desert: DESERT,
  alienBase: ALIEN_BASE,
};

/**
 * Stable list of the terrain ids eligible for the generator's RANDOM theme pick
 * (deterministic insertion order). Special themes (e.g. the alien base) are
 * excluded — they resolve only through an explicit {@link getTheme} request.
 */
export function themeIds(): string[] {
  return Object.keys(THEMES).filter((id) => THEMES[id]?.special !== true);
}

/** Look up a theme by id, or undefined when unknown. */
export function getTheme(id: string): TerrainTheme | undefined {
  return THEMES[id];
}

// ---------------------------------------------------------------------------
// Prefabs (theme-agnostic): the recoverable UFO and the squad dropship
// ---------------------------------------------------------------------------

/**
 * Tile types used only by prefabs. The generator appends these to the chosen
 * theme palette via {@link appendPrefabTiles} (which remaps indices by keeping
 * theme tiles first), then resolves prefab chars with {@link buildLegend}.
 */
export const PREFAB_TILES: TileType[] = [
  TILES.ufo_hull,
  TILES.ufo_door,
  TILES.ufo_floor,
  TILES.ufo_power,
  TILES.dropship_hull,
  TILES.dropship_floor,
];

/**
 * The classic recoverable saucer (7x7). An ufo_hull ring with two opposite
 * hatches (east/west), an ufo_floor interior, and a central "power source"
 * pillar. The four '.' corners resolve to ground (index 0), giving a rounded
 * silhouette when stamped onto any theme.
 */
export const UFO_PREFAB: TerrainBlock = block("ufo", [
  ".HHHHH.",
  "HHUUUHH",
  "HUUUUUH",
  "*UUPUU*",
  "HUUUUUH",
  "HHUUUHH",
  ".HHHHH.",
]);

/**
 * The squad dropship (5x6). A dropship_hull shell around a dropship_floor bay,
 * open at the rear (the ramp row) where the squad deploys; '.' flanks resolve
 * to ground so the craft reads as a craft, not a box.
 */
export const DROPSHIP_PREFAB: TerrainBlock = block("dropship", [
  ".SSS.",
  "SDDDS",
  "SDDDS",
  "SDDDS",
  "SDDDS",
  ".DDD.",
]);
