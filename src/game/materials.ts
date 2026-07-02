/**
 * Procedural PBR material + texture + environment library.
 *
 * Presentation-only (three.js + a DOM canvas for procedural textures). Nothing
 * here touches the sim, and nothing here is randomised per frame: every texture
 * is generated from a FIXED internal seed so the look is deterministic across
 * runs (visual variety without desyncing anything).
 *
 * The renderer is assumed to use ACESFilmic tone mapping + sRGB output, so the
 * base colours below are authored as plain sRGB hex (three converts them to the
 * linear working space). Tones are kept coherent and a touch punchy to survive
 * the highlight roll-off that ACES applies.
 *
 * Public surface:
 *   getTerrainMaterial(category)  -> shared PBR material for a tile category
 *   getFloorMaterial()            -> white-based material for the instanced floor
 *   getEmissiveMaterial(color, i) -> shared self-lit material (for bloom)
 *   getCategoryEmissive(category) -> the emissive params a category uses (or null)
 *   EMISSIVE_CATEGORIES           -> the set of categories that glow (bloom tuning)
 *   buildEnvironment(renderer)    -> PMREM env texture for IBL / reflections
 *   disposeMaterials()            -> release every cached material + texture
 */

import {
  CanvasTexture,
  MeshStandardMaterial,
  PMREMGenerator,
  RepeatWrapping,
  SRGBColorSpace,
  Vector2,
  type Texture,
  type WebGLRenderer,
} from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

// ---------------------------------------------------------------------------
// Deterministic value noise (seeded, periodic so the textures tile seamlessly)
// ---------------------------------------------------------------------------

const TEXTURE_SIZE = 256;
/** How many times the shared detail maps repeat across a 1-unit surface. */
const DETAIL_REPEAT = 2;
/** Fixed seed: identical textures every run (no frame-desyncing randomness). */
const SEED = 0x9e3779b1;

/** Small fast PRNG. Deterministic given a seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One octave of value noise: a `cells x cells` lattice of random values. */
interface Octave {
  lat: Float64Array;
  cells: number;
}

function buildOctaves(cellCounts: readonly number[], seed: number): Octave[] {
  const rng = mulberry32(seed);
  return cellCounts.map((cells) => {
    const lat = new Float64Array(cells * cells);
    for (let i = 0; i < lat.length; i++) lat[i] = rng();
    return { lat, cells };
  });
}

/** Smoothstep easing for value-noise interpolation. */
function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Sample a periodic lattice at (u, v) in [0,1) with bilinear smooth interp. */
function sampleLattice(lat: Float64Array, cells: number, u: number, v: number): number {
  const x = u * cells;
  const y = v * cells;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const ix0 = ((x0 % cells) + cells) % cells;
  const iy0 = ((y0 % cells) + cells) % cells;
  const ix1 = (ix0 + 1) % cells;
  const iy1 = (iy0 + 1) % cells;
  const v00 = lat[iy0 * cells + ix0] ?? 0;
  const v10 = lat[iy0 * cells + ix1] ?? 0;
  const v01 = lat[iy1 * cells + ix0] ?? 0;
  const v11 = lat[iy1 * cells + ix1] ?? 0;
  const a = v00 + (v10 - v00) * fx;
  const b = v01 + (v11 - v01) * fx;
  return a + (b - a) * fy;
}

/** Fractal Brownian motion over the octaves; result normalised to [0,1]. */
function fbm(octaves: readonly Octave[], u: number, v: number, persistence: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  for (const o of octaves) {
    sum += sampleLattice(o.lat, o.cells, u, v) * amp;
    norm += amp;
    amp *= persistence;
  }
  return norm > 0 ? sum / norm : 0;
}

// ---------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------

function makeContext(size: number): CanvasRenderingContext2D {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("materials: 2D canvas context unavailable");
  return ctx;
}

/** Apply the shared sampler settings (tiling + anisotropy) to a detail texture. */
function configureDetail(tex: CanvasTexture): void {
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.repeat.set(DETAIL_REPEAT, DETAIL_REPEAT);
  tex.anisotropy = 4;
  tex.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// The three shared detail maps: albedo mottling, a bump normal, roughness.
// Generated once, lazily, and shared across every material that wants them.
// ---------------------------------------------------------------------------

interface DetailTextures {
  albedo: CanvasTexture; // sRGB, near-white so it multiplies the base colour
  normal: CanvasTexture; // tangent-space, linear: subtle micro-relief
  roughness: CanvasTexture; // linear, grey: per-texel roughness variation
}

let detailTextures: DetailTextures | null = null;

/** Subtle, mostly-bright mottling that multiplies a material's base colour. */
function buildAlbedoTexture(size: number): CanvasTexture {
  const ctx = makeContext(size);
  const img = ctx.createImageData(size, size);
  const data = img.data;
  const oct = buildOctaves([6, 12, 24], SEED + 11);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(oct, x / size, y / size, 0.5);
      // Keep it bright (avg ~0.95) so the material's colour stays dominant.
      const value = 210 + n * 45;
      const idx = (y * size + x) * 4;
      data[idx] = value;
      data[idx + 1] = value;
      data[idx + 2] = value;
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new CanvasTexture(ctx.canvas);
  tex.colorSpace = SRGBColorSpace; // albedo: sRGB
  configureDetail(tex);
  return tex;
}

/** Tangent-space normal map derived from a height fBm (gentle surface relief). */
function buildNormalTexture(size: number): CanvasTexture {
  const oct = buildOctaves([4, 8, 16, 32], SEED + 23);
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      height[y * size + x] = fbm(oct, x / size, y / size, 0.5);
    }
  }

  const ctx = makeContext(size);
  const img = ctx.createImageData(size, size);
  const data = img.data;
  const strength = 2.4; // steepness of the encoded bump
  const wrap = (i: number): number => (i + size) % size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const hL = height[y * size + wrap(x - 1)] ?? 0;
      const hR = height[y * size + wrap(x + 1)] ?? 0;
      const hU = height[wrap(y - 1) * size + x] ?? 0;
      const hD = height[wrap(y + 1) * size + x] ?? 0;
      let nx = (hL - hR) * strength;
      let ny = (hU - hD) * strength;
      let nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv;
      ny *= inv;
      nz *= inv;
      const idx = (y * size + x) * 4;
      data[idx] = (nx * 0.5 + 0.5) * 255;
      data[idx + 1] = (ny * 0.5 + 0.5) * 255;
      data[idx + 2] = (nz * 0.5 + 0.5) * 255;
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new CanvasTexture(ctx.canvas);
  // Normal map: leave colorSpace at the default (NoColorSpace / linear).
  configureDetail(tex);
  return tex;
}

/** Grey roughness variation; multiplies a material's `roughness` scalar. */
function buildRoughnessTexture(size: number): CanvasTexture {
  const ctx = makeContext(size);
  const img = ctx.createImageData(size, size);
  const data = img.data;
  const oct = buildOctaves([5, 10, 20], SEED + 37);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(oct, x / size, y / size, 0.5);
      // Vary the multiplier in [0.65, 1.0]: never fully smooth.
      const value = (0.65 + n * 0.35) * 255;
      const idx = (y * size + x) * 4;
      data[idx] = value;
      data[idx + 1] = value;
      data[idx + 2] = value;
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new CanvasTexture(ctx.canvas);
  // Roughness map: linear data, leave colorSpace default.
  configureDetail(tex);
  return tex;
}

function getDetailTextures(): DetailTextures {
  if (!detailTextures) {
    detailTextures = {
      albedo: buildAlbedoTexture(TEXTURE_SIZE),
      normal: buildNormalTexture(TEXTURE_SIZE),
      roughness: buildRoughnessTexture(TEXTURE_SIZE),
    };
  }
  return detailTextures;
}

// ---------------------------------------------------------------------------
// Per-category material specs
// ---------------------------------------------------------------------------

interface MatSpec {
  /** Base colour (sRGB hex). For features this is the raised geometry's colour. */
  color: number;
  roughness: number;
  metalness: number;
  /** Apply the shared detail maps (albedo + normal + roughness). */
  detail?: boolean;
  /** Apply only the detail normal (e.g. metal panels). */
  normalOnly?: boolean;
  /** Normal map strength (Vector2 scale); defaults to 0.5 when maps applied. */
  normalScale?: number;
  /** Self-illumination colour (sRGB hex). */
  emissive?: number;
  emissiveIntensity?: number;
  /** Translucent surfaces such as glass. */
  opacity?: number;
  /** scene.environment contribution (reflections); defaults to 0.6. */
  envIntensity?: number;
}

/**
 * Every render category -> its PBR look. Ground categories double as a usable
 * surface material; feature categories use the raised geometry's colour. Metal
 * hulls lean on the environment map for reflections; alien decks / windows /
 * hatches carry an emissive accent so post-processing bloom can pick them up.
 */
const SPECS: Record<string, MatSpec> = {
  // -- Walkable open ground / floors ---------------------------------------
  grass: { color: 0x5c8a3a, roughness: 0.95, metalness: 0, detail: true, normalScale: 0.5 },
  soil: { color: 0x6e4a2c, roughness: 0.98, metalness: 0, detail: true, normalScale: 0.6 },
  crop: { color: 0x9ba83a, roughness: 0.9, metalness: 0, detail: true, normalScale: 0.5 },
  road: { color: 0x3a3d42, roughness: 0.8, metalness: 0, detail: true, normalScale: 0.35 },
  pavement: { color: 0x777c83, roughness: 0.85, metalness: 0, detail: true, normalScale: 0.4 },
  sand: { color: 0xcdb070, roughness: 0.95, metalness: 0, detail: true, normalScale: 0.45 },
  floor_wood: { color: 0x8a5a30, roughness: 0.7, metalness: 0.05, detail: true, normalScale: 0.4 },
  floor_concrete: { color: 0x666a71, roughness: 0.85, metalness: 0.02, detail: true, normalScale: 0.4 },
  ufo_floor: {
    color: 0x2c8079, roughness: 0.5, metalness: 0.2, detail: true, normalScale: 0.3,
    emissive: 0x0c3b37, emissiveIntensity: 0.6, envIntensity: 0.9,
  },
  dropship_floor: { color: 0x58646f, roughness: 0.7, metalness: 0.3, detail: true, normalScale: 0.35, envIntensity: 0.7 },

  // -- Openings: threshold markers -----------------------------------------
  door: { color: 0xc89a52, roughness: 0.6, metalness: 0.05, detail: true, normalScale: 0.4 },
  ufo_door: {
    color: 0x39d6c0, roughness: 0.4, metalness: 0.3,
    emissive: 0x1f8f82, emissiveIntensity: 1.2, envIntensity: 0.9,
  },

  // -- Partial cover -------------------------------------------------------
  fence: { color: 0x8a6a3a, roughness: 0.8, metalness: 0.05, detail: true, normalScale: 0.4 },
  window: {
    color: 0x9fd3e6, roughness: 0.05, metalness: 0, opacity: 0.35,
    emissive: 0x163a44, emissiveIntensity: 0.5, envIntensity: 1.1,
  },
  crate: { color: 0xbf8438, roughness: 0.75, metalness: 0.05, detail: true, normalScale: 0.45 },
  barrel: { color: 0xc0642c, roughness: 0.5, metalness: 0.4, normalOnly: true, normalScale: 0.25, envIntensity: 0.7 },
  rubble: { color: 0x7d735f, roughness: 0.95, metalness: 0.02, detail: true, normalScale: 0.7 },
  hedge: { color: 0x2f5a28, roughness: 0.95, metalness: 0, detail: true, normalScale: 0.6 },
  bush: { color: 0x3a6b30, roughness: 0.95, metalness: 0, detail: true, normalScale: 0.6 },
  // Chest-high concrete emplacement (renderer's low_wall = FULL shoot-over
  // cover). A distinctly WARM taupe so it reads as a tactical object, never as
  // the cool architectural walls below (Track 4 item 2 value separation).
  low_wall: { color: 0x9c8b6e, roughness: 0.9, metalness: 0.02, detail: true, normalScale: 0.5 },

  // -- Full cover / blockers ------------------------------------------------
  // Walls are cool desaturated grey (high value, low chroma) so architecture
  // reads distinctly from the WARM cover objects above and the terrain floors.
  wall_building: { color: 0xa0a4a8, roughness: 0.9, metalness: 0.02, detail: true, normalScale: 0.5 },
  wall_interior: { color: 0x8a8e92, roughness: 0.85, metalness: 0.02, detail: true, normalScale: 0.45 },
  rock: { color: 0x6f6960, roughness: 0.95, metalness: 0.02, detail: true, normalScale: 0.85 },
  tree: { color: 0x2f6b30, roughness: 0.9, metalness: 0, detail: true, normalScale: 0.55 },
  ufo_hull: {
    color: 0x9fb6c6, roughness: 0.28, metalness: 0.9, normalOnly: true, normalScale: 0.25,
    emissive: 0x12303a, emissiveIntensity: 0.5, envIntensity: 1.4,
  },
  dropship_hull: {
    color: 0x6b7682, roughness: 0.35, metalness: 0.85, normalOnly: true, normalScale: 0.25,
    emissive: 0x0e1822, emissiveIntensity: 0.4, envIntensity: 1.2,
  },

  // -- Additive theme pack (arctic / jungle / forest) -----------------------
  // Slippery arctic ground (white-blue), slick ice, and a glacial block; deep
  // jungle undergrowth and a fallen log; mixed woodland earth + a sunlit
  // clearing. See src/sim/terrain.themes.extra.ts for the sim data.
  snow: { color: 0xdfe7ef, roughness: 0.9, metalness: 0, detail: true, normalScale: 0.35 },
  ice: { color: 0xa9c6d6, roughness: 0.28, metalness: 0, detail: true, normalScale: 0.2, envIntensity: 0.9 },
  ice_block: { color: 0xb8c8d4, roughness: 0.45, metalness: 0.05, detail: true, normalScale: 0.6 },
  jungle_floor: { color: 0x2f5a28, roughness: 0.95, metalness: 0, detail: true, normalScale: 0.6 },
  log: { color: 0x6b4a2c, roughness: 0.85, metalness: 0.05, detail: true, normalScale: 0.5 },
  forest_floor: { color: 0x4a5a32, roughness: 0.95, metalness: 0, detail: true, normalScale: 0.6 },
  clearing: { color: 0x6f8a3e, roughness: 0.9, metalness: 0, detail: true, normalScale: 0.5 },
};

/** Fallback for an unknown category: a plain neutral surface. */
const FALLBACK_SPEC: MatSpec = { color: 0x6a727c, roughness: 0.85, metalness: 0.05, detail: true, normalScale: 0.4 };

/** Categories whose material carries an emissive accent (for bloom tuning). */
export const EMISSIVE_CATEGORIES: ReadonlySet<string> = new Set(
  Object.keys(SPECS).filter((key) => SPECS[key]?.emissive !== undefined),
);

// ---------------------------------------------------------------------------
// Material factories (cached)
// ---------------------------------------------------------------------------

const terrainCache = new Map<string, MeshStandardMaterial>();
const emissiveCache = new Map<string, MeshStandardMaterial>();
let floorMaterial: MeshStandardMaterial | null = null;

function buildMaterial(spec: MatSpec): MeshStandardMaterial {
  const mat = new MeshStandardMaterial({
    color: spec.color,
    roughness: spec.roughness,
    metalness: spec.metalness,
  });
  mat.envMapIntensity = spec.envIntensity ?? 0.6;

  if (spec.detail === true || spec.normalOnly === true) {
    const detail = getDetailTextures();
    const scale = spec.normalScale ?? 0.5;
    mat.normalMap = detail.normal;
    mat.normalScale = new Vector2(scale, scale);
    if (spec.detail === true) {
      mat.map = detail.albedo;
      mat.roughnessMap = detail.roughness;
    }
  }

  if (spec.emissive !== undefined) {
    mat.emissive.setHex(spec.emissive);
    mat.emissiveIntensity = spec.emissiveIntensity ?? 1;
  }

  if (spec.opacity !== undefined) {
    mat.transparent = true;
    mat.opacity = spec.opacity;
  }

  return mat;
}

/**
 * Shared PBR material for a render category. Cached: the SAME instance is
 * returned for repeated calls, so meshes batch into fewer draw calls.
 *
 * NOTE on fog-of-war: because the material is shared, callers must NOT mutate
 * its `.color` / `.emissive` per tile to dim explored terrain — that would dim
 * every tile of the category at once. Clone the result per feature mesh when
 * independent dimming is required (see integration notes).
 */
export function getTerrainMaterial(category: string): MeshStandardMaterial {
  const cached = terrainCache.get(category);
  if (cached) return cached;
  const spec = SPECS[category] ?? FALLBACK_SPEC;
  const mat = buildMaterial(spec);
  terrainCache.set(category, mat);
  return mat;
}

/**
 * Material for the instanced floor: white base (so per-instance `setColorAt`
 * fog tones multiply through cleanly) carrying the shared detail normal +
 * roughness maps so the ground reads as a surface rather than a flat fill.
 * Shared singleton — the InstancedMesh only needs one material.
 */
export function getFloorMaterial(): MeshStandardMaterial {
  if (!floorMaterial) {
    const detail = getDetailTextures();
    const mat = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
    mat.normalMap = detail.normal;
    mat.normalScale = new Vector2(0.45, 0.45);
    mat.roughnessMap = detail.roughness;
    mat.envMapIntensity = 0.4;
    floorMaterial = mat;
  }
  return floorMaterial;
}

/**
 * Shared self-lit material for glowing accents (window panes, UFO running
 * lights, character visors / eyes). Author `intensity` >= ~1.5 so it survives
 * ACES tone mapping and crosses a typical bloom threshold. Cached by colour +
 * intensity.
 */
export function getEmissiveMaterial(color: number, intensity = 2): MeshStandardMaterial {
  const key = `${color.toString(16)}:${intensity}`;
  const cached = emissiveCache.get(key);
  if (cached) return cached;
  const mat = new MeshStandardMaterial({
    color: 0x05070a,
    roughness: 0.4,
    metalness: 0,
  });
  mat.emissive.setHex(color);
  mat.emissiveIntensity = intensity;
  emissiveCache.set(key, mat);
  return mat;
}

/** The emissive params a category uses (for bloom tuning), or null if matte. */
export function getCategoryEmissive(category: string): { color: number; intensity: number } | null {
  const spec = SPECS[category];
  if (!spec || spec.emissive === undefined) return null;
  return { color: spec.emissive, intensity: spec.emissiveIntensity ?? 1 };
}

// ---------------------------------------------------------------------------
// Environment map (image-based lighting / reflections)
// ---------------------------------------------------------------------------

let cachedEnv: Texture | null = null;

/**
 * Build a PMREM environment map from three's built-in {@link RoomEnvironment}.
 * The caller sets `scene.environment = result` so every PBR material gets soft
 * image-based lighting and the metal hulls get believable reflections. The
 * PMREM generator and the transient room scene are disposed before returning.
 */
export function buildEnvironment(renderer: WebGLRenderer): Texture {
  if (cachedEnv) cachedEnv.dispose();

  const room = new RoomEnvironment();
  const pmrem = new PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(room, 0.04).texture;
  pmrem.dispose();
  disposeRoom(room);

  cachedEnv = envTex;
  return envTex;
}

/** Dispose the throwaway room scene's geometries + materials (no leaks). */
function disposeRoom(room: RoomEnvironment): void {
  room.traverse((obj) => {
    const mesh = obj as { geometry?: { dispose: () => void }; material?: unknown };
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material;
    if (Array.isArray(mat)) {
      for (const m of mat) (m as { dispose: () => void }).dispose();
    } else if (mat && typeof (mat as { dispose?: unknown }).dispose === "function") {
      (mat as { dispose: () => void }).dispose();
    }
  });
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

/** Dispose every cached material, texture and the environment map. */
export function disposeMaterials(): void {
  for (const mat of terrainCache.values()) mat.dispose();
  terrainCache.clear();

  for (const mat of emissiveCache.values()) mat.dispose();
  emissiveCache.clear();

  if (floorMaterial) {
    floorMaterial.dispose();
    floorMaterial = null;
  }

  if (detailTextures) {
    detailTextures.albedo.dispose();
    detailTextures.normal.dispose();
    detailTextures.roughness.dispose();
    detailTextures = null;
  }

  if (cachedEnv) {
    cachedEnv.dispose();
    cachedEnv = null;
  }
}
