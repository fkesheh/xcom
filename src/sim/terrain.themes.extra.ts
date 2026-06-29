/**
 * Additive terrain theme pack: ARCTIC, JUNGLE, FOREST.
 *
 * This module is PURE DATA + a one-time registration side effect — no three.js,
 * no DOM, no Math.random. It is shipped alongside the sealed core
 * ({@link ./terrain}) and extends the battlescape vocabulary WITHOUT editing it:
 *
 *  - Three new dominant GROUND tiles (snow / jungle_floor / forest_floor) and a
 *    few themed COVER props (ice_block, log, clearing, ice) each carrying a NEW
 *    `render` category the renderer maps to a fresh look (see SPECS in
 *    src/game/materials.ts). Tactical flags follow the core conventions:
 *      · ice_block = full cover, blocks move + sight (a glacial boulder).
 *      · log       = half cover, blocks move NOT sight (a fallen trunk you fire
 *                    over, like crate/barrel).
 *      · ice/snow  = slippery walkable ground (higher moveCost).
 *  - Three handcrafted {@link TerrainTheme}s with 10x10 ASCII blocks drawn from
 *    the shared {@link CHAR_TO_ID} legend PLUS four new chars registered below.
 *  - Self-registration: on import it appends the new chars to {@link CHAR_TO_ID}
 *    and the new themes to {@link THEMES}. Because {@link themeIds}/{@link getTheme}
 *    (and therefore {@link generateMap}) read those two objects live, the seeded
 *    theme pick now spans all SIX themes wherever this module is loaded. It is
 *    imported as a side effect by the production skirmish builder (setup.ts) so a
 *    real mission can land in any of the six zones; core tests that exercise
 *    generateMap in isolation stay scoped to the three sealed themes.
 *
 * Determinism is preserved: registration is a constant-time mutation performed
 * once (ES module bodies run once), the new tiles are plain data, and every map
 * choice still flows through the single seeded Rng — so `same seed => same map`.
 */

import type { TileType } from "./types";
import type { TerrainBlock, TerrainTheme } from "./terrain";
import { CHAR_TO_ID, TILES, THEMES } from "./terrain";

// ---------------------------------------------------------------------------
// Identity helper (mirrors the sealed core): contextual literal typing -> TileType.
// ---------------------------------------------------------------------------

function tile(t: TileType): TileType {
  return t;
}

/** Build a {@link TerrainBlock}, deriving w/h from the rows (w = first row length). */
function block(id: string, rows: string[]): TerrainBlock {
  return { id, w: rows[0]?.length ?? 0, h: rows.length, rows };
}

// ---------------------------------------------------------------------------
// New tile types (each carries a NEW render category). The rest of each theme
// palette is composed from the shared core TILES vocabulary (tree, rock, bush,
// crate, ...) so the sealed legend resolves them unchanged.
// ---------------------------------------------------------------------------

/** New tile types introduced by this theme pack, keyed by stable id. */
export const EXTRA_TILES = {
  // -- Arctic ground + cover ------------------------------------------------
  /** Slippery packed snow: the arctic dominant ground. Higher moveCost = trudging. */
  snow: tile({
    id: "snow", label: "Snow", render: "snow",
    blocksMove: false, blocksSight: false, moveCost: 6, cover: 0, destructible: false,
  }),
  /** Slick blue ice patch: walkable but very slow (highest moveCost ground). */
  ice: tile({
    id: "ice", label: "Ice", render: "ice",
    blocksMove: false, blocksSight: false, moveCost: 7, cover: 0, destructible: false,
  }),
  /** Solid glacial block: full cover, blocks move + sight (like rock, but icy). */
  ice_block: tile({
    id: "ice_block", label: "Ice Block", render: "ice_block",
    blocksMove: true, blocksSight: true, moveCost: 0, cover: 2, destructible: false,
  }),

  // -- Jungle ground + cover ------------------------------------------------
  /** Dense loamy undergrowth: the jungle dominant ground. moveCost 5 = pushing through. */
  jungle_floor: tile({
    id: "jungle_floor", label: "Jungle Floor", render: "jungle_floor",
    blocksMove: false, blocksSight: false, moveCost: 5, cover: 0, destructible: false,
  }),
  /** Fallen log: half cover, blocks move NOT sight — fire over it, like a crate. */
  log: tile({
    id: "log", label: "Fallen Log", render: "log",
    blocksMove: true, blocksSight: false, moveCost: 0, cover: 1, destructible: true,
  }),

  // -- Forest ground --------------------------------------------------------
  /** Mixed woodland earth: the forest dominant ground. */
  forest_floor: tile({
    id: "forest_floor", label: "Forest Floor", render: "forest_floor",
    blocksMove: false, blocksSight: false, moveCost: 4, cover: 0, destructible: false,
  }),
  /** Open clearing in the canopy: walkable, slightly faster (moveCost 3, like a road). */
  clearing: tile({
    id: "clearing", label: "Clearing", render: "clearing",
    blocksMove: false, blocksSight: false, moveCost: 3, cover: 0, destructible: false,
  }),
} satisfies Record<string, TileType>;

/**
 * Render categories introduced by this theme pack. The renderer must handle each
 * (see SPECS in src/game/materials.ts); like the core {@link RENDER_CATEGORIES},
 * unknown categories fall back to a neutral surface so a missing spec never throws.
 */
export const EXTRA_RENDER_CATEGORIES: readonly string[] = [
  "snow", "ice", "ice_block",
  "jungle_floor", "log",
  "forest_floor", "clearing",
];

/**
 * New ASCII legend chars (char -> tile id), appended to the shared
 * {@link CHAR_TO_ID}. Chosen to avoid every existing legend char. Unlisted
 * themes simply omit the referenced tile id from their palette, so a char that
 * no theme palette contains resolves to ground via the legend fallback — no
 * cross-theme contamination.
 */
const EXTRA_CHARS: Record<string, string> = {
  e: "ice", // slippery ice ground patch
  I: "ice_block", // full-cover glacial block
  l: "log", // half-cover fallen log
  o: "clearing", // open forest clearing
};

// ---------------------------------------------------------------------------
// Theme: ARCTIC (blowing-snow crash site) — sparse cover, slippery ground
// ---------------------------------------------------------------------------

const ARCTIC_PALETTE: TileType[] = [
  EXTRA_TILES.snow, // 0 — dominant ground
  EXTRA_TILES.ice,
  TILES.road,
  TILES.floor_concrete,
  EXTRA_TILES.ice_block,
  TILES.crate,
  TILES.barrel,
  TILES.rock,
  TILES.bush,
  TILES.wall_building,
  TILES.wall_interior,
  TILES.door,
  TILES.window,
  TILES.sandbags,
  TILES.low_wall,
];

const ARCTIC_BLOCKS: TerrainBlock[] = [
  // Open snowfield with a couple of slick ice patches, one rock, sparse scrub.
  block("arctic_tundra", [
    "..........",
    "....e.....",
    "..........",
    ".....R....",
    "..........",
    "..e.......",
    "........e.",
    "....v.....",
    "..........",
    "..........",
  ]),
  // Drifted ice field: a couple of small icebergs (ice blocks) and a crate.
  block("arctic_icefield", [
    "..e....e..",
    "..........",
    "...II.....",
    "...II..x..",
    "..........",
    ".e.....e..",
    "....II....",
    "..........",
    "..b.......",
    "..........",
  ]),
  // Concrete research hut on the snow: window to shoot through, a door, one crate.
  block("arctic_shelter", [
    "..........",
    "...######.",
    "...#OOOO#.",
    "...#O%OO#.",
    "...nOOO+#.",
    "...#OOOO#.",
    "...####...",
    "..........",
    ".....x....",
    "..........",
  ]),
  // Glacial ridge: a spine of ice blocks + rocks with gaps to thread through.
  block("arctic_ridge", [
    "..........",
    "..R.II.R..",
    "..........",
    ".II.......",
    ".....RR...",
    "..........",
    "...I...x..",
    "..........",
    ".e.....e..",
    "..........",
  ]),
];

const ARCTIC: TerrainTheme = {
  id: "arctic",
  name: "Arctic",
  palette: ARCTIC_PALETTE,
  blocks: ARCTIC_BLOCKS,
};

// ---------------------------------------------------------------------------
// Theme: JUNGLE (dense canopy) — abundant half cover, concealment everywhere
// ---------------------------------------------------------------------------

const JUNGLE_PALETTE: TileType[] = [
  EXTRA_TILES.jungle_floor, // 0 — dominant ground
  TILES.grass,
  TILES.road,
  TILES.floor_wood,
  TILES.bush,
  TILES.hedge,
  EXTRA_TILES.log,
  TILES.tree,
  TILES.rock,
  TILES.crate,
  TILES.wall_building,
  TILES.wall_interior,
  TILES.door,
  TILES.window,
  TILES.sandbags,
  TILES.low_wall,
];

const JUNGLE_BLOCKS: TerrainBlock[] = [
  // Thick tangle: bushes + hedges (concealment) threaded with logs and trees.
  block("jungle_dense", [
    ".v.v..h.h.",
    "vhvv..hhh.",
    ".v.....l..",
    "....vv..T.",
    ".h...vv...",
    ".v.....l..",
    "...v..hh..",
    "h.v..T....",
    ".vh....v..",
    "..v..h..v.",
  ]),
  // Hide in the clearing: a grass opening ringed by sight-blocking hedges, two logs.
  block("jungle_clearing", [
    "hhhh..hhhh",
    "h..gggg..h",
    "h.gg..gg.h",
    "h.gl..lg.h",
    "h.ggllgg.h",
    "h..gggg..h",
    "hhhh..hhhh",
    "...T..T...",
    "..v....v..",
    "..........",
  ]),
  // Overgrown wooden hideout: walls + door + window, vines (hedge) creeping in.
  block("jungle_ruin", [
    "..........",
    "..#######.",
    "..#WWWWW#.",
    "..nW%WWW#.",
    "..#WW+W+#.",
    "h.#WWWWW#.",
    ".h.######.",
    "..h....h..",
    "...v..v...",
    "..........",
  ]),
  // Dense canopy thicket: trees, logs and broad foliage — hard to see through.
  block("jungle_thicket", [
    "T.v..h..T.",
    ".vT...v..h",
    "h.....l.v.",
    ".v..T...l.",
    "T...v..h..",
    ".h...l...T",
    "..v..h.v..",
    "l...T...v.",
    ".h.v...l.T",
    "T.v...h..v",
  ]),
];

const JUNGLE: TerrainTheme = {
  id: "jungle",
  name: "Jungle",
  palette: JUNGLE_PALETTE,
  blocks: JUNGLE_BLOCKS,
};

// ---------------------------------------------------------------------------
// Theme: FOREST (mixed woodland) — tree-trunk full cover, moderate density
// ---------------------------------------------------------------------------

const FOREST_PALETTE: TileType[] = [
  EXTRA_TILES.forest_floor, // 0 — dominant ground
  TILES.grass,
  EXTRA_TILES.clearing,
  TILES.road,
  TILES.floor_wood,
  TILES.tree,
  TILES.bush,
  TILES.rock,
  EXTRA_TILES.log,
  TILES.crate,
  TILES.barrel,
  TILES.wall_building,
  TILES.wall_interior,
  TILES.door,
  TILES.window,
  TILES.sandbags,
  TILES.low_wall,
];

const FOREST_BLOCKS: TerrainBlock[] = [
  // Stand of trees around a central clearing (open in the middle, trunks ringing).
  block("forest_trees", [
    "..T....T..",
    "....T.....",
    ".T...o...T",
    "....ooo...",
    "..T.ooo.T.",
    "....ooo...",
    ".T...o...T",
    "....T.....",
    "..T....T..",
    "..........",
  ]),
  // Campsite clearing: logs + a crate + barrel, ringed by tree trunks.
  block("forest_camp", [
    "TT......TT",
    "T........T",
    "...ooooo..",
    "...olxlo..",
    "...ooooo..",
    "T........T",
    "TT..b...TT",
    "...T..T...",
    "..........",
    "....RR....",
  ]),
  // Woodland cabin: walls, window, door on a forest floor with a trail to it.
  block("forest_cabin", [
    "..........",
    "..#######.",
    "..#WWWWW#.",
    "..nW%WWW#.",
    "..#WW+WW#.",
    "..#WWWWW#.",
    "..###+##..",
    "....r.....",
    "...T...T..",
    "..........",
  ]),
  // Rocky outcrop scattered with trunks, fallen logs and brush.
  block("forest_rocks", [
    "..R...T...",
    ".RR..v....",
    ".R...T..R.",
    "....RR....",
    ".T..l..T..",
    "...v...v..",
    ".R...T...R",
    "....l.....",
    "T...RR..T.",
    "....v.....",
  ]),
];

const FOREST: TerrainTheme = {
  id: "forest",
  name: "Forest",
  palette: FOREST_PALETTE,
  blocks: FOREST_BLOCKS,
};

// ---------------------------------------------------------------------------
// One-time registration (runs on first import; ES module bodies execute once)
// ---------------------------------------------------------------------------

/** The three themes added by this pack, keyed by id (mirrors the core THEMES shape). */
export const EXTRA_THEMES: Record<string, TerrainTheme> = {
  arctic: ARCTIC,
  jungle: JUNGLE,
  forest: FOREST,
};

// Append the new legend chars. Idempotent across HMR / repeated import: only
// writes when the char is not already mapped, and only to its intended id.
for (const [char, id] of Object.entries(EXTRA_CHARS)) {
  if (CHAR_TO_ID[char] === undefined) CHAR_TO_ID[char] = id;
}

// Register the new themes into the live core registry that themeIds()/getTheme()
// (and therefore generateMap) read. Never overwrites a core theme id.
for (const [id, theme] of Object.entries(EXTRA_THEMES)) {
  if (THEMES[id] === undefined) THEMES[id] = theme;
}
