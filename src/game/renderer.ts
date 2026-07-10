/**
 * three.js presentation layer.
 *
 * The renderer is a pure VIEW: it reads {@link BattleState}, draws it, raycasts
 * pointer input back into tile/unit coordinates, and plays short awaitable
 * animations for {@link GameEvent}s. It never mutates game state and never
 * decides anything that affects the sim — that all lives behind Commands.
 *
 * Visual-only randomness (none is used here) would be fine, but game state is
 * never touched, so determinism is unaffected.
 *
 * Pipeline: a PBR scene (shadow-casting sun + hemisphere/ambient fill + an
 * image-based-lighting environment for the metallic hulls) is rendered through
 * an EffectComposer — RenderPass -> UnrealBloomPass (so only emissive accents,
 * plasma/tracer FX and the very brightest sunlit highlights glow) -> OutputPass
 * (ACES tone mapping + sRGB). Terrain is an instanced floor (per-instance colour
 * drives fog) plus per-feature props from {@link ./props}; their materials come
 * from {@link ./materials} and are cloned per tile so fog dimming stays local.
 */

import {
  ACESFilmicToneMapping,
  AmbientLight,
  BoxGeometry,
  BufferGeometry,
  CircleGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  Fog,
  Group,
  HemisphereLight,
  InstancedMesh,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  MOUSE,
  Object3D,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Raycaster,
  RingGeometry,
  CanvasTexture,
  Scene,
  Shape,
  ShapeGeometry,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

import type { BattleState, GameEvent, TileType, Unit, UnitId, Vec2 } from "../sim/types";
import { cellIndex, tileTypeAt } from "../sim/index";
import { visibleEnemyIds, visibleTiles } from "../sim/index";

import {
  createCharacterMesh,
  disposeCharacter,
  setCharacterPose,
  setCharacterWalkPose,
} from "./characters";
import { Effects, type ProjectileKind } from "./effects";
import {
  buildEnvironment,
  disposeMaterials,
  getFloorMaterial,
  getTerrainMaterial,
} from "./materials";
import { createFeature } from "./props";
import { buildWall, connectsTo, openingOf, wallFamilyOf } from "./walls";
import type { WallFamily, WallNeighbors } from "./walls";
import {
  classifyTile,
  dir8ToAngleY,
  hpColor,
  hpFraction,
  lerp,
  tileToWorld,
  type TileVisibility,
} from "./coords";

// ---------------------------------------------------------------------------
// Palette (presentation-only colours, keyed by sim tile id).
// ---------------------------------------------------------------------------

const COLORS = {
  background: 0x0a0d12,
  // Unexplored / never-seen tone: near-black #05080f (mean luminance < 12) so
  // fog reads as a true void, never a muddy grey (Track 4 item 4).
  groundVoid: 0x05080f,
  selectRing: 0x38e8d2, // teal friendly accent (Style Bible primary)
  pathOk: 0x39d98a,
  hover: 0xfacc15,
  aim: 0xff6b5a,
  hpBack: 0x111418,
  // Cover indicators: tint PAIRED with a distinct glyph (half- vs full-shield),
  // never colour alone. Amber = partial cover (caution); blue = full cover (safe).
  coverHalf: 0xf2b13a,
  coverFull: 0x4cc8f5,
  // Map-wide cover-edge highlight (teal) drawn on the covered flank of a cover
  // tile when a friendly stands adjacent (Track 4 item 2, visual only).
  coverEdge: 0x38e8d2,
} as const;

/**
 * Fog-of-war rendering (Track 4 item 4), three states:
 *   hidden   = never seen -> painted the near-black void tone, features HIDDEN,
 *              so unexplored ground reads as a true void (< 12 mean luminance).
 *   explored = seen before -> desaturated toward grey (a "memory" look) and
 *              dimmed, but kept LEGIBLE (mean ~18-70) so the ground still reads.
 *   visible  = in a living friendly's line of sight -> full lit colour.
 * Explored/visible terrain is drawn so known structure stays continuous; the
 * fog only dims/desaturates it. Enemy UNITS are hidden by fog separately.
 */
const EXPLORED_FLOOR_DIM = 0.34;
const EXPLORED_FEATURE_DIM = 0.42;
/** How far an explored tile is pulled toward its own luminance-grey (memory). */
const EXPLORED_DESAT = 0.5;

/** Reused colours: the never-seen void tone and scratches for dimming maths. */
const FOG_VOID = new Color(COLORS.groundVoid);
const SCRATCH_COLOR = new Color();
const SCRATCH_COLOR_B = new Color();

/**
 * Desaturate + dim a lit base colour into `out` for the explored ("remembered")
 * fog state: pull each linear channel toward the colour's own luminance-grey by
 * `desat`, then scale by `dim`. Luminance-grey desaturation keeps the tone
 * readable (never a flat wash) while draining the vividness of live vision.
 */
function fogExplored(out: Color, base: Color, desat: number, dim: number): Color {
  const l = 0.2126 * base.r + 0.7152 * base.g + 0.0722 * base.b;
  out.setRGB(
    (base.r + (l - base.r) * desat) * dim,
    (base.g + (l - base.g) * desat) * dim,
    (base.b + (l - base.b) * desat) * dim,
  );
  return out;
}
const BLACK = new Color(0, 0, 0);
/** Reddened emissive tint blended over a hit figure for the damage flash. */
const HIT_RED = new Color(1, 0.08, 0.08);
/** Electric-cyan emissive tint blended over a stunned figure (distinct from the
 *  red damage flash — a non-lethal takedown reads differently from a bullet hit). */
const STUN_CYAN = new Color(0.35, 0.9, 1);
/** Desaturated grey a KO'd (unconscious, captured) figure is pulled toward. */
const KO_GREY = new Color(0.32, 0.34, 0.4);
/** World-up constant: shared by the camera pan/orbit hot paths instead of a per-frame `new Vector3(0,1,0)`. */
const UP = new Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// Time-of-day lighting (presentation-only). Derived from state.hourOfDay so a
// night mission (launched after dark) renders dim, cool and tight-sighted,
// while day missions keep the bright key-lit look. The sim is untouched — this
// only tunes light intensities/colours, fog reach and exposure.
// ---------------------------------------------------------------------------

type TimeOfDay = "day" | "dusk" | "night";

interface TimeOfDayLighting {
  sunIntensity: number;
  sunColor: number;
  hemiIntensity: number;
  hemiSky: number;
  hemiGround: number;
  ambientIntensity: number;
  ambientColor: number;
  envIntensity: number;
  background: number;
  exposure: number;
  bloomStrength: number;
  /** Fog near/far as a multiple of the map's larger dimension. */
  fogNearMult: number;
  fogFarMult: number;
  /** Intensity of the warm practical light pools over lit buildings (0 = off).
   *  Off by day; lit at dusk/night so the cool grade gets warm pools (item 5). */
  practical: number;
}

// Warm practical light pools (Track 4 item 5): a capped set of amber PointLights
// parked over lit-building tiles, lit only at dusk/night.
const PRACTICAL_MAX = 8;
const PRACTICAL_COLOR = 0xffb066; // warm incandescent lamp / firelight
const PRACTICAL_DISTANCE = 7.5; // fall-off radius of one pool
/** Render categories that read as a warm practical light source (lit windows). */
const PRACTICAL_LAMP_CATEGORIES: ReadonlySet<string> = new Set(["wall_building", "door"]);

/**
 * Hour buckets: 6..18 = day, 18..20 / 5..6 = dusk, else night. An unset hour
 * (skirmish launched outside the campaign clock) reads as day so quick battles
 * stay bright.
 */
function classifyHourOfDay(hour: number | undefined): TimeOfDay {
  if (hour === undefined) return "day";
  if (hour >= 18 && hour < 20) return "dusk";
  if (hour >= 5 && hour < 6) return "dusk";
  if (hour >= 6 && hour < 18) return "day";
  return "night";
}

const TIME_OF_DAY: Record<TimeOfDay, TimeOfDayLighting> = {
  // DAY = the authored bright look (sun + warm fill, wide sight via far fog).
  day: {
    sunIntensity: 1.15,
    sunColor: 0xfff2dc,
    hemiIntensity: 0.55,
    hemiSky: 0xbcd2ff,
    hemiGround: 0x33312c,
    ambientIntensity: 0.15,
    ambientColor: 0xffffff,
    envIntensity: 0.35,
    background: COLORS.background,
    exposure: 0.82,
    bloomStrength: 0.35,
    fogNearMult: 1.4,
    fogFarMult: 3.4,
    practical: 0, // daylight: no practicals
  },
  // DUSK = low warm sun, cooler fill, moderately pulled-in fog.
  dusk: {
    sunIntensity: 0.6,
    sunColor: 0xff9a55,
    hemiIntensity: 0.4,
    hemiSky: 0x3a4a7a,
    hemiGround: 0x2a2622,
    ambientIntensity: 0.1,
    ambientColor: 0xb8a8c0,
    envIntensity: 0.25,
    background: 0x141018,
    exposure: 0.74,
    bloomStrength: 0.42,
    fogNearMult: 1.15,
    fogFarMult: 2.85,
    practical: 1.2, // dusk: soft warm pools begin to read
  },
  // NIGHT = dim cool moonlight, blue ambient, tight fog so the squad reads but
  // the field fades to dark. Emissive accents (UFO lights, tracers, visors) and
  // the stronger bloom make it feel dangerous without going pitch-black.
  night: {
    // Keep the night tactical, but lift the key/fill enough that terrain shape
    // and cover remain readable outside emissive UFO panels.
    sunIntensity: 0.24,
    sunColor: 0x5a78b8,
    hemiIntensity: 0.32,
    hemiSky: 0x1a2240,
    hemiGround: 0x121418,
    ambientIntensity: 0.1,
    ambientColor: 0x6a7ab0,
    envIntensity: 0.22,
    background: 0x05070f,
    exposure: 0.7,
    bloomStrength: 0.55,
    fogNearMult: 0.95,
    fogFarMult: 2.2,
    practical: 2.4, // night: strong warm pools break up the cool blue grade
  },
};

const TWEEN_MS = 150;
const MOVE_TWEEN_MS = 220;
// Hit-reaction flinch + ragdoll-collapse timing (presentation-only).
const HIT_REACT_MS = 200;
const DEATH_COLLAPSE_MS = 420;
/** Stun-rod strike flash duration (a snappy electric jolt). */
const STUN_REACT_MS = 240;
/** How long a floating stun number rises and fades above the struck target. */
const STUN_FLOAT_MS = 900;
// Screen-shake envelope: an explosion adds an impulse to a decaying energy
// value (exp decay). Only EXPLOSIONS shake (Track 4 item 6) — gunfire / stun no
// longer do — and the decay is tuned so the perceptible motion is gone within
// ~250ms. reducedMotion suppresses it entirely (a classic motion trigger).
const SHAKE_DECAY_RATE = 20; // amplitude imperceptible (< 0.005) by ~180ms
const SHAKE_MAX = 0.16;
/** Explosion concussion impulse (world-unit amplitude). */
const SHAKE_BLAST = 0.15;

// ---------------------------------------------------------------------------
// Floor tones — the per-tile colour painted onto the instanced floor quad (and
// dimmed for fog). The raised feature itself (wall, hull, tree, …) comes from
// props.ts; this is just the ground tone under/around it. Tones are muted
// mid-greys/earths picked to read under ACES tone mapping without blooming.
// ---------------------------------------------------------------------------

const GROUND_TONES: Record<string, number> = {
  // Walkable open ground / floors.
  grass: 0x4a7a39,
  soil: 0x6e4a2c,
  crop: 0x9ba83a,
  road: 0x3a3d42,
  pavement: 0x767b82,
  sand: 0xc8ad6c,
  floor_wood: 0x8a5a30,
  floor_concrete: 0x64686f,
  ufo_floor: 0x2c8079,
  dropship_floor: 0x58646f,
  // Openings (floor-level thresholds).
  door: 0x7a5a34,
  ufo_door: 0x1f5a55,
  // Partial cover.
  fence: 0x55602f,
  window: 0x73777d,
  crate: 0x6b665d,
  barrel: 0x6b665d,
  rubble: 0x6b665d,
  hedge: 0x3f5a2e,
  bush: 0x4a6a34,
  sandbags: 0x7d6e44,
  // Full cover / blockers.
  wall_building: 0x5c574e,
  wall_interior: 0x5c574e,
  rock: 0x7a746a,
  tree: 0x4f5a34,
  ufo_hull: 0x224844,
  dropship_hull: 0x454f59,
  low_wall: 0x5c574e,
  // Additive theme pack (arctic / jungle / forest).
  snow: 0xc4d2de,
  ice: 0x8fb4c8,
  ice_block: 0x96a8b6,
  jungle_floor: 0x2f5a28,
  log: 0x6b4a2c,
  forest_floor: 0x475a36,
  clearing: 0x6a8a3e,
};

/** Ground tone when a tile has no (or an unknown) render category. */
const FALLBACK_GROUND = 0x39485a;

/**
 * Resolve a tile's render category. Prefers the data-driven `render`; falls
 * back to the legacy blocksMove/cover heuristic for palettes without it.
 */
function categoryFor(tile: TileType | undefined): string | undefined {
  if (tile?.render !== undefined) return tile.render;
  if (tile === undefined) return undefined;
  if (tile.blocksMove && tile.blocksSight) return "wall_building";
  if (tile.cover > 0) return "crate";
  return undefined;
}

/** The lit floor tone for a category (mid-grey fallback for the unknown ones). */
function groundToneFor(category: string | undefined): number {
  if (category === undefined) return FALLBACK_GROUND;
  return GROUND_TONES[category] ?? FALLBACK_GROUND;
}

/** Low-saturation tactical-field tint by map theme; purely a presentation backdrop. */
function theaterTintFor(themeId: string | undefined): number {
  switch (themeId) {
    case "urban": return 0x162b42;
    case "desert": return 0x49351d;
    case "arctic": return 0x163d52;
    case "jungle": return 0x123d27;
    case "forest": return 0x263d22;
    case "alienBase": return 0x302050;
    case "farmland":
    default: return 0x153727;
  }
}

/** A lit MeshStandardMaterial part + its base tones, ready for per-tile fog dimming. */
function makeFeaturePart(mat: MeshStandardMaterial): FeaturePart {
  const glows = mat.emissiveIntensity > 0 && !mat.emissive.equals(BLACK);
  return { mat, base: mat.color.clone(), emissiveBase: glows ? mat.emissive.clone() : null };
}

/**
 * Clone every mesh's material on a freshly built feature so per-tile fog
 * dimming can mutate colour/emissive without touching the shared cache in
 * materials.ts. Clones SHARE texture references (no extra texture memory).
 */
function cloneFeatureMaterials(obj: Object3D): FeaturePart[] {
  const parts: FeaturePart[] = [];
  obj.traverse((node) => {
    if (!(node instanceof Mesh)) return;
    const src = node.material;
    if (Array.isArray(src)) {
      node.material = src.map((m) => {
        const clone = (m as MeshStandardMaterial).clone();
        parts.push(makeFeaturePart(clone));
        return clone;
      });
    } else {
      const clone = (src as MeshStandardMaterial).clone();
      node.material = clone;
      parts.push(makeFeaturePart(clone));
    }
  });
  return parts;
}

/** A flat ground quad (long axis on X, normal +Y): baked so only a world-Y yaw
 *  is needed to orient it. Used for the cover-edge highlight bars. */
function makeGroundBarGeometry(len: number, width: number): PlaneGeometry {
  const g = new PlaneGeometry(len, width);
  g.rotateX(-Math.PI / 2);
  return g;
}

/** Promise-based tween: drives `onUpdate(t in [0,1])` for `ms`, then resolves. */
/** Rasterize a short label to a CanvasTexture for a billboarded sprite (floating
 *  combat readouts). Bold, outlined text so it reads against any battlescape. */
function makeTextTexture(text: string, fill: string): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.font = "bold 44px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 6;
    ctx.strokeStyle = "rgba(2,6,12,0.9)";
    ctx.strokeText(text, 128, 34);
    ctx.fillStyle = fill;
    ctx.fillText(text, 128, 34);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

function tween(ms: number, onUpdate: (t: number) => void): Promise<void> {
  return new Promise<void>((resolve) => {
    const start = performance.now();
    const step = (now: number): void => {
      const t = ms <= 0 ? 1 : Math.min(1, (now - start) / ms);
      onUpdate(t);
      if (t < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

interface UnitView {
  root: Group; // tile position + death scale
  character: Group; // procedural figure, rotated to face the unit's Dir8
  hpBar: Group; // billboarded toward the camera
  hpFill: Mesh;
  /** Lazily-captured base material tones, used to desaturate then restore a
   *  KO'd (unconscious) figure without cumulative drift across syncs. */
  koParts?: { mat: MeshStandardMaterial; color: Color; emissiveIntensity: number }[];
  /** Whether the figure is currently rendered in its unconscious (laid-down,
   *  dimmed) state — toggled in applyUnconscious so restore runs exactly once. */
  ko?: boolean;
}

/** One coloured material of a tile feature, with its lit base tones (for fog). */
interface FeaturePart {
  mat: MeshStandardMaterial;
  base: Color;
  emissiveBase: Color | null;
}

/** A tile's raised feature: the object in the scene graph + its dimmable parts. */
interface TileFeature {
  object: Object3D;
  parts: FeaturePart[];
  /** Render category this feature was built for, so sync can detect drift. */
  category: string | undefined;
}

const HP_BAR_W = 0.8;
const HP_BAR_Y = 1.55;
/** HP bar height when kneeling (tracks the crouched figure's head). */
const HP_BAR_Y_KNEEL = 1.18;
/** Character Y-scale when kneeling (crouch ~30% lower, about the feet). */
const STANCE_KNEEL_SCALE = 0.72;

// ---------------------------------------------------------------------------
// Cover emplacement geometry (half / full cover that walls.ts + props.ts omit)
// ---------------------------------------------------------------------------

/**
 * A stacked-sandbag emplacement: HALF cover (~40% wall height). blocksMove but
 * NOT blocksSight — you fire over it. Reads as a low tan obstacle distinct from
 * full walls and open ground. `variant` (the cell index) seeds deterministic
 * per-tile jitter so the pillows vary without desyncing anything.
 */
function buildSandbags(variant: number): Group {
  const group = new Group();
  const mat = getTerrainMaterial("crate"); // tan hessian read; cloned per tile for fog
  const bag = (x: number, y: number, z: number, rot: number): void => {
    const m = new Mesh(new SphereGeometry(0.23, 12, 10), mat);
    m.castShadow = true;
    m.receiveShadow = true;
    m.scale.set(1.05, 0.62, 0.82);
    m.position.set(x, y, z);
    m.rotation.y = rot;
    group.add(m);
  };
  // Deterministic per-tile jitter (no Math.random): tiny yaw per bag.
  const j = (n: number): number =>
    ((Math.imul(variant + n, 0x9e37b79f) >>> 0) / 4294967296) * 0.5 - 0.25;
  // Bottom row of three overlapping pillows + a top bag bridging the gap.
  bag(-0.26, 0.24, 0.06, j(1));
  bag(0.02, 0.24, -0.12, j(2));
  bag(0.26, 0.24, 0.1, j(3));
  bag(0.0, 0.52, 0.0, j(4));
  return group;
}

/**
 * A chest-high concrete barrier: FULL shoot-over cover (~70% wall height).
 * blocksMove but NOT blocksSight — a low wall you can fire over but not enter.
 * Distinct from sight-blocking walls (which fully occlude line of fire).
 */
function buildLowWall(_variant: number): Group {
  const group = new Group();
  // Warm taupe concrete (its own category) so full cover reads distinctly from
  // the cool architectural walls; cloned per tile for fog.
  const mat = getTerrainMaterial("low_wall");
  const h = 1.3;
  const body = new Mesh(new BoxGeometry(0.88, h, 0.5), mat);
  body.castShadow = true;
  body.receiveShadow = true;
  body.position.y = h / 2;
  group.add(body);
  const cap = new Mesh(new BoxGeometry(0.94, 0.12, 0.56), mat);
  cap.castShadow = true;
  cap.receiveShadow = true;
  cap.position.y = h - 0.06;
  group.add(cap);
  return group;
}

// ---------------------------------------------------------------------------
// Civilian figure (terror-site noncombatants)
// ---------------------------------------------------------------------------
//
// Built here rather than in characters.ts so civilians read as unarmed, plain-
// clothes bystanders — clearly distinct from the armed blue troopers and the red
// alien enemies, so the player can tell at a glance who to protect. Constructed
// only from primitives this module already imports; every geometry/material is
// owned by the figure, so the shared disposeCharacter() walker releases them.
// Distinctiveness is SHAPE-led (no weapon, no helmet, no glowing visor, soft
// plain-clothes tones), never colour alone.

/** Muted, clearly-non-combatant shirt tones (deterministic pick per civilian). */
const CIVILIAN_SHIRTS: readonly number[] = [0xc9b06a, 0x9a8f6e, 0x7d8a96, 0xa67b5b];
const CIVILIAN_TROUSERS = 0x3a3d42;
const CIVILIAN_SHOES = 0x24262b;
const CIVILIAN_SKIN = 0xd9b48f;
const CIVILIAN_HAIR = 0x4a3a2a;

function civilianShirtFor(id: number): number {
  return CIVILIAN_SHIRTS[Math.abs(id) % CIVILIAN_SHIRTS.length]!;
}

/** Rough, non-metallic plain-cloth material — no armour specular, no emissive glow. */
function civilianMaterial(color: number): MeshStandardMaterial {
  return new MeshStandardMaterial({ color, roughness: 0.9, metalness: 0.0, flatShading: true });
}

/**
 * Build an unarmed civilian humanoid: feet at y = 0, ~1.45 tall, local +Z
 * forward (consistent with the armed figures). Legs are named leftLeg/rightLeg
 * so the shared walk-pose reset composes cleanly; civilians never act, but this
 * keeps them consistent with the pose machinery. Carries `userData.unitId` on
 * every descendant so the renderer's recursive raycast can pick them.
 */
function buildCivilianFigure(unit: Unit): Group {
  const root = new Group();
  const shirt = civilianMaterial(civilianShirtFor(unit.id));
  const trousers = civilianMaterial(CIVILIAN_TROUSERS);
  const shoes = civilianMaterial(CIVILIAN_SHOES);
  const skin = civilianMaterial(CIVILIAN_SKIN);
  const hair = civilianMaterial(CIVILIAN_HAIR);

  const add = (geo: BufferGeometry, mat: MeshStandardMaterial, x: number, y: number, z: number): Mesh => {
    const mesh = new Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.set(x, y, z);
    root.add(mesh);
    return mesh;
  };

  // Legs (trousers) with shoes — named for walk-pose consistency with troopers.
  for (const side of [-1, 1] as const) {
    const leg = new Group();
    leg.name = side < 0 ? "leftLeg" : "rightLeg";
    leg.position.set(0.12 * side, 0.84, 0);
    root.add(leg);
    const limb = new Mesh(new BoxGeometry(0.14, 0.56, 0.16), trousers);
    limb.castShadow = true;
    limb.receiveShadow = true;
    limb.position.y = -0.28;
    leg.add(limb);
    const shoe = new Mesh(new BoxGeometry(0.16, 0.08, 0.26), shoes);
    shoe.castShadow = true;
    shoe.receiveShadow = true;
    shoe.position.set(0, -0.62, 0.04);
    leg.add(shoe);
  }

  // Pelvis + torso (shirt): plain boxy civilian clothes — no chest plate, no pauldrons.
  add(new BoxGeometry(0.34, 0.2, 0.24), trousers, 0, 0.88, 0);
  const torso = add(new BoxGeometry(0.36, 0.4, 0.2), shirt, 0, 1.14, 0);
  torso.scale.set(1, 1, 0.85);

  // Arms (shirt sleeves) hanging EMPTY at the sides — no weapon, no rifle.
  for (const side of [-1, 1] as const) {
    const arm = new Mesh(new BoxGeometry(0.1, 0.4, 0.12), shirt);
    arm.castShadow = true;
    arm.receiveShadow = true;
    arm.position.set(0.23 * side, 1.12, 0);
    arm.rotation.z = 0.08 * side;
    root.add(arm);
    const hand = new Mesh(new SphereGeometry(0.05, 10, 8), skin);
    hand.castShadow = true;
    hand.receiveShadow = true;
    hand.position.set(0.25 * side, 0.92, 0.02);
    root.add(hand);
  }

  // Neck + head (skin) + hair cap. No helmet, no glowing visor.
  add(new BoxGeometry(0.1, 0.08, 0.1), skin, 0, 1.36, 0);
  const head = add(new SphereGeometry(0.11, 14, 12), skin, 0, 1.44, 0);
  head.scale.set(1, 1.05, 1);
  const hairCap = add(
    new SphereGeometry(0.122, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55),
    hair,
    0,
    1.46,
    -0.01,
  );
  hairCap.scale.set(1, 1, 1.05);

  root.userData.unitId = unit.id;
  root.traverse((obj) => {
    obj.userData.unitId = unit.id;
  });
  return root;
}

export class Renderer {
  private readonly renderer: WebGLRenderer;
  private readonly scene: Scene;
  private readonly camera: PerspectiveCamera;
  private readonly composer: EffectComposer;
  private readonly bloomPass: UnrealBloomPass;
  private controls!: OrbitControls;
  private container: HTMLElement | null = null;
  // WebGL context-loss recovery. Without a `webglcontextlost` listener that
  // calls preventDefault(), a lost context (alt-tab / driver TDR / context cap)
  // is permanent for the page session — every later render() no-ops or throws.
  // While `contextLost` is set, render() is a no-op so we neither spin on a dead
  // context nor spam errors; the controller is expected to re-mount the screen.
  private contextLost = false;
  private onContextLost: ((e: Event) => void) | null = null;
  private onContextRestored: (() => void) | null = null;

  /** The shadow-casting "sun"; reframed onto the map in {@link buildGrid}. */
  private readonly sun: DirectionalLight;
  /** Sky/ground hemisphere fill; retuned per time-of-day. */
  private readonly hemi: HemisphereLight;
  /** Flat ambient lift so shadowed detail survives; retuned per time-of-day. */
  private readonly ambient: AmbientLight;

  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();

  private grid: BattleState["grid"] | null = null;
  private groundPlane: Mesh | null = null;
  /** Soft tactical field + perimeter ring beneath the playable map (visual only). */
  private theaterPlate: Mesh | null = null;
  private theaterPlateMaterial: MeshBasicMaterial | null = null;
  private theaterRimMaterial: MeshBasicMaterial | null = null;
  private theaterBaseColor: Color | null = null;
  private readonly tileGroup = new Group();
  // Floor layer: one InstancedMesh (per-tile colour + fog), indexed by cellIndex.
  private floorMesh: InstancedMesh | null = null;
  private readonly floorBase: Color[] = []; // lit ground tone per cell index
  private readonly featureMeshes = new Map<number, TileFeature>(); // raised features

  private readonly unitGroup = new Group();
  private readonly unitViews = new Map<UnitId, UnitView>();

  private readonly fxGroup = new Group(); // tracers (transient)
  private readonly effects = new Effects(this.fxGroup); // projectile / impact FX
  private readonly previewGroup = new Group(); // path + aim, cleared often
  // Deployed smoke clouds (translucent grey-blue). The geometry + material are
  // shared across every cloud mesh; sync clears the group each frame and
  // rebuilds it from state.smokeClouds, so the shared resources are never
  // disposed mid-life (only the per-cloud meshes come and go).
  private readonly smokeGroup = new Group();
  private readonly smokeGeometry = new SphereGeometry(1, 16, 12);
  private readonly smokeMaterial = new MeshStandardMaterial({
    color: 0x9fb4c4,
    transparent: true,
    opacity: 0.5,
    roughness: 1,
    metalness: 0,
    depthWrite: false,
  });
  // Deployed item markers: proximity mines (small red dot per planted tile) and
  // motion-scanner pulses (a faint cyan pad under each scanning unit). Built per
  // sync from state.mines / unit.scanRadius, mirroring the smoke-cloud pattern.
  private readonly markerGroup = new Group();
  private readonly markerGeometry = new SphereGeometry(1, 12, 8);
  private readonly mineMaterial = new MeshStandardMaterial({
    color: 0xff3b30,
    emissive: 0xff3b30,
    emissiveIntensity: 0.8,
    roughness: 0.5,
    metalness: 0,
    transparent: true,
    opacity: 0.95,
  });
  private readonly scannerMaterial = new MeshBasicMaterial({
    color: 0x6ee7ff,
    transparent: true,
    opacity: 0.12,
    depthWrite: false,
  });
  private selectionRing: Mesh | null = null;
  private selectionHalo: Mesh | null = null;
  /** Small teal wedge on the selection ring showing the selected unit's facing. */
  private selectionTick: Mesh | null = null;
  private hoverMarker: Mesh | null = null;
  private coverIndicatorGroup: Group | null = null;
  // Map-wide cover-edge highlight (Track 4 item 2): a thin teal bar drawn on the
  // covered flank of a cover tile when a living friendly stands adjacent. The
  // geometry + material are shared; syncFromState clears the group and rebuilds
  // the per-edge meshes (mirroring the smoke/marker pattern), so the shared
  // resources live for the renderer's lifetime and only the wrappers churn.
  private readonly coverEdgeGroup = new Group();
  // Pre-flattened to the ground plane (long axis on X, normal +Y) so a single
  // clean rotation.y orients each bar along its edge — no Euler ambiguity.
  private readonly coverEdgeGeometry = makeGroundBarGeometry(0.66, 0.12);
  // Dual-coded by cover strength (matches the shield-glyph tint semantics):
  // amber = half cover (caution), blue = full cover (safe). A single teal bar
  // would collapse the sim's 1-vs-2 cover distinction the player relies on.
  private readonly coverEdgeHalfMaterial = new MeshBasicMaterial({
    color: COLORS.coverHalf,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
  });
  private readonly coverEdgeFullMaterial = new MeshBasicMaterial({
    color: COLORS.coverFull,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
  });
  // Warm practical light pools for NIGHT/DUSK missions (Track 4 item 5): a
  // small pooled set of amber PointLights parked over lit-building tiles so the
  // cool blue night grade is broken up by warm pools where lamps exist. Created
  // once in buildGrid from candidate tiles, toggled per time-of-day, disposed
  // with the grid. Capped so the forward+shadow lighting cost stays bounded.
  private readonly practicalLights: { light: PointLight; idx: number }[] = [];
  /** Practical-light intensity for the current time-of-day (0 = off by day).
   *  applyTimeOfDay caches it; updatePracticalLights gates each lamp on its own
   *  tile being explored/visible so no warm pool bleeds out of unseen fog. */
  private practicalBaseIntensity = 0;
  private objectiveBeacon: Group | null = null;
  private objectiveBeaconTarget: Vec2 | null = null;
  private carrierBeacon: Group | null = null;
  private extractionGroup: Group | null = null;
  private selectedId: UnitId | null = null;

  // Camera focus easing.
  private readonly desiredTarget = new Vector3();
  private panActive = false;

  // Pooled scratch vectors reused by the per-frame camera hot paths (panBy /
  // orbitYaw / focus-pan) so sustained WASD/arrows/Q-E movement allocates zero
  // Vector3s per frame instead of ~6. Matches the scratch pattern in geoscape.ts.
  private readonly scratchFwd = new Vector3();
  private readonly scratchRight = new Vector3();
  private readonly scratchMove = new Vector3();
  private readonly scratchOffset = new Vector3();

  // Screen shake: impulses add to a decaying energy envelope; each frame pushes
  // a randomised offset onto the camera position, then strips it back before the
  // next OrbitControls.update() so the orbit never drifts. No per-frame alloc.
  private shakeEnergy = 0;
  private readonly shakeOffset = new Vector3();
  private lastRenderSec = 0;

  /**
   * Honour prefers-reduced-motion: suppress screen shake and freeze the
   * decorative selection/beacon pulses (motion that communicates nothing the
   * static state doesn't). Read once at construction like the other views.
   */
  private readonly reducedMotion: boolean =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  constructor() {
    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // ACES + sRGB are applied at the end of the composer by OutputPass; the
    // material colours in materials.ts were authored for exactly this.
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.82;
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;

    this.scene = new Scene();
    this.scene.background = new Color(COLORS.background);
    // Image-based lighting: soft fill on every PBR material + believable
    // reflections on the metallic UFO / dropship hulls.
    this.scene.environment = buildEnvironment(this.renderer);
    // Dial back IBL so the sky doesn't wash everything out.
    this.scene.environmentIntensity = 0.35;

    this.camera = new PerspectiveCamera(50, 1, 0.1, 500);

    this.sun = new DirectionalLight(0xfff2dc, 1.15);
    // Sky/ground gradient fill + flat ambient; intensities/colours are retuned
    // per time-of-day in applyTimeOfDay.
    this.hemi = new HemisphereLight(0xbcd2ff, 0x33312c, 0.55);
    this.hemi.position.set(0, 40, 0);
    this.ambient = new AmbientLight(0xffffff, 0.15);
    this.scene.add(this.tileGroup, this.unitGroup, this.fxGroup, this.previewGroup);
    this.scene.add(this.smokeGroup);
    this.scene.add(this.markerGroup);
    this.scene.add(this.coverEdgeGroup);
    this.addLights();

    // Post-processing: bloom only catches emissive accents / FX / bright glints.
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // strength, radius, threshold. Threshold > 1 so only HDR emissive accents
    // (UFO lights, plasma/FX, visors) bloom — never the lit floor/terrain.
    this.bloomPass = new UnrealBloomPass(new Vector2(1, 1), 0.35, 0.4, 1.1);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  mount(container: HTMLElement): void {
    this.container = container;
    container.appendChild(this.renderer.domElement);

    // Allow the WebGL context to be recovered after a loss (tab switch / GPU
    // driver TDR / per-process context cap). preventDefault() is load-bearing:
    // without it the loss is permanent. On restore we clear the flag; the real
    // GPU-resource rebuild is handled by the controller re-mounting the screen.
    const canvas = this.renderer.domElement;
    this.onContextLost = (e: Event): void => {
      e.preventDefault();
      this.contextLost = true;
    };
    this.onContextRestored = (): void => {
      this.contextLost = false;
    };
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = 1.45; // keep above the ground plane
    this.controls.minDistance = 6;
    this.controls.maxDistance = 60;
    // Drag-to-pan is the primary "move the map" gesture (left-CLICK still
    // selects/moves units — clicks and drags are separated by a slop threshold
    // in the controller). Rotate moves to the right button. Pan along the
    // ground plane, not the screen plane, so it feels map-like.
    this.controls.mouseButtons = { LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.ROTATE };
    this.controls.screenSpacePanning = false;
    // A manual drag cancels any in-flight camera focus pan.
    this.controls.addEventListener("start", () => {
      this.panActive = false;
    });

    this.resize();
  }

  /** The canvas element the controller attaches pointer listeners to. */
  domElementForInput(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /**
   * True while the WebGL context is lost. The controller can poll this to show a
   * "Graphics context lost — reloading…" overlay and re-mount the screen; the
   * renderer itself only survives the loss (skips render, allows recovery) and
   * does not own the overlay or its own mount lifecycle.
   */
  get isContextLost(): boolean {
    return this.contextLost;
  }

  private addLights(): void {
    // Key light = the sun. Shadow camera bounds are fitted to the map once its
    // size is known (buildGrid -> frameSunShadow). The hemisphere + ambient
    // fills are created in the constructor and retuned per time-of-day in
    // applyTimeOfDay; the IBL environment adds the rest of the fill.
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0001;
    this.sun.shadow.normalBias = 0.03; // characters self-shadow: avoid acne

    this.scene.add(this.hemi, this.ambient, this.sun, this.sun.target);
  }

  /**
   * Retune scene lighting, fog reach, tone-mapping exposure and bloom to the
   * battle's time-of-day (derived from state.hourOfDay). DAY keeps the authored
   * bright look; DUSK dims + warms; NIGHT drops to dim cool moonlight with tight
   * fog so distant terrain fades to dark (the "narrowed vision" cue) while the
   * squad stays lit. Idempotent — hourOfDay is fixed for a battle, but this runs
   * every sync cheaply. The sim is never touched.
   */
  private applyTimeOfDay(state: BattleState): void {
    const cfg = TIME_OF_DAY[classifyHourOfDay(state.hourOfDay)];

    this.sun.intensity = cfg.sunIntensity;
    this.sun.color.setHex(cfg.sunColor);

    this.hemi.intensity = cfg.hemiIntensity;
    this.hemi.color.setHex(cfg.hemiSky);
    this.hemi.groundColor.setHex(cfg.hemiGround);

    this.ambient.intensity = cfg.ambientIntensity;
    this.ambient.color.setHex(cfg.ambientColor);

    this.scene.environmentIntensity = cfg.envIntensity;
    this.renderer.toneMappingExposure = cfg.exposure;
    this.bloomPass.strength = cfg.bloomStrength;

    // Warm practical pools: dark by day, lit at dusk/night (item 5). Cache the
    // base intensity here; updatePracticalLights (called from syncFromState once
    // fog visibility is known) gates each lamp on its own tile being seen and
    // toggles `visible` so day maps pay zero point-light shader cost.
    this.practicalBaseIntensity = cfg.practical;

    if (this.scene.background instanceof Color) {
      this.scene.background.setHex(cfg.background);
    }
    this.updateTheaterBackdrop(cfg);

    const size = this.grid ? Math.max(this.grid.width, this.grid.height) : 30;
    if (this.scene.fog instanceof Fog) {
      this.scene.fog.color.setHex(cfg.background);
      this.scene.fog.near = size * cfg.fogNearMult;
      this.scene.fog.far = size * cfg.fogFarMult;
    }
  }

  /**
   * Build the warm practical light pool set (Track 4 item 5) from lit-building
   * candidate tiles, capped at {@link PRACTICAL_MAX} and spread evenly so a big
   * building doesn't hog the whole budget. Lights start dark; applyTimeOfDay
   * lifts them at dusk/night. They cast no shadows (cheap fill). Disposed with
   * the grid. A map with no buildings gets none — the cool grade stands alone.
   */
  private buildPracticalLights(
    candidates: ReadonlyArray<{ x: number; z: number; idx: number }>,
  ): void {
    if (candidates.length === 0) return;
    const stride = Math.max(1, Math.floor(candidates.length / PRACTICAL_MAX));
    for (let i = 0; i < candidates.length && this.practicalLights.length < PRACTICAL_MAX; i += stride) {
      const c = candidates[i]!;
      const light = new PointLight(PRACTICAL_COLOR, 0, PRACTICAL_DISTANCE, 2);
      light.position.set(c.x, 1.5, c.z);
      light.castShadow = false;
      // Start hidden: a day mission keeps practicals off, and a visible
      // intensity-0 light still counts toward NUM_POINT_LIGHTS, making every lit
      // material pay the point-light loop for lamps that contribute nothing.
      // updatePracticalLights turns them on only at dusk/night for seen tiles.
      light.visible = false;
      this.scene.add(light);
      this.practicalLights.push({ light, idx: c.idx });
    }
  }

  /**
   * Gate the warm practical pools by BOTH time-of-day and fog: a lamp is lit
   * only when practicals are on for the hour (dusk/night) AND its own tile has
   * been seen. This keeps two invariants: day maps pay zero point-light cost
   * (all lamps hidden), and no warm pool bleeds out of never-explored fog to
   * disclose a building the void is meant to hide. Runs each sync after
   * visibility is computed; pure toggles, no allocation.
   */
  private updatePracticalLights(state: BattleState, visibleCells: ReadonlySet<number>): void {
    const on = this.practicalBaseIntensity > 0;
    for (const p of this.practicalLights) {
      const seen = on && (visibleCells.has(p.idx) || state.explored.has(p.idx));
      p.light.visible = seen;
      p.light.intensity = seen ? this.practicalBaseIntensity : 0;
    }
  }

  /** Fit the sun + its orthographic shadow camera tightly around the board. */
  private frameSunShadow(width: number, height: number): void {
    const cx = (width - 1) / 2;
    const cz = (height - 1) / 2;
    const size = Math.max(width, height);

    this.sun.target.position.set(cx, 0, cz);
    this.sun.position.set(cx + size * 0.5, size * 1.2, cz - size * 0.35);
    this.sun.target.updateMatrixWorld();

    const r = size * 0.75; // half-extent covering the whole map + a margin
    const cam = this.sun.shadow.camera;
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = 0.5;
    cam.far = size * 4;
    cam.updateProjectionMatrix();
  }

  resize(): void {
    if (!this.container) return;
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h); // also resizes the bloom pass render targets
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Draw a frame. Eases the focus pan and billboards HP bars first. */
  render(): void {
    // Skip while the WebGL context is lost: rendering would no-op or throw, and
    // we'd rather hold the last frame until the screen is re-mounted on restore.
    if (this.contextLost) return;
    const now = performance.now() * 0.001;
    const dt = this.lastRenderSec === 0 ? 0 : Math.min(0.05, now - this.lastRenderSec);
    this.lastRenderSec = now;

    // Strip last frame's shake offset FIRST so OrbitControls sees the camera's
    // true orbit position and the shake never accumulates into drift.
    if (this.shakeOffset.x !== 0 || this.shakeOffset.y !== 0 || this.shakeOffset.z !== 0) {
      this.camera.position.sub(this.shakeOffset);
    }

    if (this.panActive && this.controls) {
      const delta = this.scratchOffset.copy(this.desiredTarget).sub(this.controls.target);
      if (delta.lengthSq() < 0.0004) {
        this.panActive = false;
      } else {
        const step = delta.multiplyScalar(0.12);
        this.controls.target.add(step);
        this.camera.position.add(step);
      }
    }
    this.controls?.update();
    for (const view of this.unitViews.values()) {
      if (view.root.visible) view.hpBar.quaternion.copy(this.camera.quaternion);
    }
    // Decorative pulses communicate nothing the static markers don't, so they
    // are frozen under prefers-reduced-motion (Style Bible rule 2).
    if (this.selectionRing?.visible) {
      const w = this.reducedMotion ? 0 : Math.sin(now * 4);
      this.selectionRing.scale.setScalar(0.92 + w * 0.08);
      (this.selectionRing.material as MeshBasicMaterial).opacity = 0.72 + w * 0.16;
    }
    if (this.selectionHalo?.visible) {
      const w = this.reducedMotion ? 0 : Math.sin(now * 2.5);
      this.selectionHalo.scale.setScalar(1.02 + w * 0.12);
      (this.selectionHalo.material as MeshBasicMaterial).opacity = 0.18 + w * 0.07;
    }
    if (this.objectiveBeacon) {
      const pulse = 1 + (this.reducedMotion ? 0 : Math.sin(now * 1.8) * 0.08);
      this.objectiveBeacon.scale.set(pulse, 1, pulse);
    }
    if (this.carrierBeacon?.visible) {
      const pulse = 1 + (this.reducedMotion ? 0 : Math.sin(now * 3.2) * 0.08);
      this.carrierBeacon.scale.set(pulse, pulse, pulse);
    }

    // Apply screen shake: decay the energy envelope, push a random offset onto
    // the camera (stripped back at the top of the next frame). Purely cosmetic;
    // randomness is fine here — this is the presentation loop, never the sim.
    if (this.shakeEnergy > 1e-4) {
      this.shakeEnergy *= Math.exp(-dt * SHAKE_DECAY_RATE);
      this.shakeOffset.set(
        (Math.random() * 2 - 1) * this.shakeEnergy,
        (Math.random() * 2 - 1) * this.shakeEnergy,
        (Math.random() * 2 - 1) * this.shakeEnergy,
      );
      this.camera.position.add(this.shakeOffset);
    } else {
      this.shakeEnergy = 0;
      this.shakeOffset.set(0, 0, 0);
    }

    this.composer.render();
  }

  /** Add a screen-shake impulse (world-unit amplitude; decays within ~250ms).
   *  Suppressed entirely under prefers-reduced-motion. */
  private addShake(amplitude: number): void {
    if (this.reducedMotion) return;
    this.shakeEnergy = Math.min(this.shakeEnergy + amplitude, SHAKE_MAX);
  }

  /** Distance from camera to its orbit target (used to scale keyboard pan speed). */
  get cameraDistance(): number {
    return this.controls ? this.camera.position.distanceTo(this.controls.target) : 30;
  }

  /**
   * Pan the camera + orbit target across the ground plane, screen-relative:
   * +right moves the view right, +forward moves it away from the viewer.
   */
  panBy(right: number, forward: number): void {
    if (!this.controls) return;
    const fwd = this.scratchFwd;
    this.camera.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) return;
    fwd.normalize();
    const rightDir = this.scratchRight.crossVectors(fwd, UP).normalize();
    const move = this.scratchMove.set(0, 0, 0).addScaledVector(rightDir, right).addScaledVector(fwd, forward);
    this.camera.position.add(move);
    this.controls.target.add(move);
    this.panActive = false; // cancel any in-flight focus ease
  }

  /** Orbit the camera around its target by `angle` radians about world Y. */
  orbitYaw(angle: number): void {
    if (!this.controls) return;
    const offset = this.scratchOffset.copy(this.camera.position).sub(this.controls.target);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const x = offset.x * cos - offset.z * sin;
    const z = offset.x * sin + offset.z * cos;
    offset.x = x;
    offset.z = z;
    this.camera.position.copy(this.controls.target).add(offset);
    this.panActive = false;
  }

  // -------------------------------------------------------------------------
  // World construction (static map) + per-frame state sync
  // -------------------------------------------------------------------------

  /**
   * Give the battlefield a subtle physical envelope instead of letting the board
   * end abruptly in pure black. The plate stays below every tactical tile and
   * carries a theme-aware tint; its thin perimeter reads as a command-table
   * boundary without affecting raycasts, fog, or gameplay geometry.
   */
  private buildTheaterBackdrop(state: BattleState): void {
    const size = Math.max(state.grid.width, state.grid.height);
    const radius = size * 1.32;
    const cx = (state.grid.width - 1) / 2;
    const cz = (state.grid.height - 1) / 2;
    const base = new Color(theaterTintFor(state.themeId));
    const plateMaterial = new MeshBasicMaterial({
      color: base,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
    });
    const plate = new Mesh(new CircleGeometry(radius, 72), plateMaterial);
    plate.rotation.x = -Math.PI / 2;
    plate.position.set(cx, -0.075, cz);
    plate.renderOrder = -2;

    const rimMaterial = new MeshBasicMaterial({
      color: base.clone().lerp(new Color(COLORS.selectRing), 0.45),
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
    });
    const rim = new Mesh(new RingGeometry(radius * 0.94, radius * 0.955, 96), rimMaterial);
    rim.rotation.x = -Math.PI / 2;
    rim.position.set(cx, -0.065, cz);
    rim.renderOrder = -1;

    this.theaterPlate = plate;
    this.theaterPlateMaterial = plateMaterial;
    this.theaterRimMaterial = rimMaterial;
    this.theaterBaseColor = base;
    this.scene.add(plate, rim);
  }

  /** Retint the tactical envelope with the same day/dusk/night grade as the board. */
  private updateTheaterBackdrop(cfg: TimeOfDayLighting): void {
    if (!this.theaterBaseColor || !this.theaterPlateMaterial || !this.theaterRimMaterial) return;
    const illumination = cfg.practical > 0 ? 0.72 : 1;
    this.theaterPlateMaterial.color.copy(this.theaterBaseColor).multiplyScalar(illumination);
    this.theaterPlateMaterial.opacity = cfg.practical > 0 ? 0.38 : 0.3;
    this.theaterRimMaterial.color.copy(this.theaterBaseColor).lerp(SCRATCH_COLOR.setHex(COLORS.selectRing), 0.48);
    this.theaterRimMaterial.opacity = cfg.practical > 0 ? 0.28 : 0.2;
  }

  private buildGrid(state: BattleState): void {
    const { grid } = state;
    this.grid = grid;
    const cells = grid.width * grid.height;

    // Distance fog tuned to the backdrop so the board edges fade gently.
    const size = Math.max(grid.width, grid.height);
    this.scene.fog = new Fog(COLORS.background, size * 1.4, size * 3.4);

    // Continuous ground plane: the raycast target for tile picking + backdrop.
    const planeGeo = new PlaneGeometry(grid.width, grid.height);
    const planeMat = new MeshStandardMaterial({ color: COLORS.groundVoid, roughness: 1 });
    const plane = new Mesh(planeGeo, planeMat);
    plane.rotation.x = -Math.PI / 2;
    plane.position.set((grid.width - 1) / 2, -0.04, (grid.height - 1) / 2);
    plane.receiveShadow = true;
    this.groundPlane = plane;
    this.scene.add(plane);
    this.buildTheaterBackdrop(state);

    // Floor layer: ONE InstancedMesh of flat quads, one instance per tile keyed
    // by cellIndex. The shared white-based floor material (with detail normal +
    // roughness maps) lets the per-instance colour show as-is; fog dims those
    // colours in syncFromState. Raised features (the minority of tiles) come
    // from props.createFeature as individual meshes so composite shapes stay
    // simple and fog-dim per tile.
    const floor = new InstancedMesh(new PlaneGeometry(0.96, 0.96), getFloorMaterial(), cells);
    floor.frustumCulled = false; // a flat board: cheaper to keep every tile drawn
    floor.castShadow = false;
    floor.receiveShadow = true;
    const dummy = new Object3D();
    dummy.rotation.x = -Math.PI / 2;
    const lampCandidates: { x: number; z: number; idx: number }[] = [];
    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        const idx = cellIndex(grid, x, y);
        const w = tileToWorld(x, y, 0);
        dummy.position.set(w.x, 0.005, w.z);
        dummy.updateMatrix();
        floor.setMatrixAt(idx, dummy.matrix);

        const category = categoryFor(tileTypeAt(grid, x, y));
        const base = new Color(groundToneFor(category));
        this.floorBase[idx] = base;
        floor.setColorAt(idx, base);

        const feature = this.buildTileFeature(category, idx, w.x, w.z, x, y);
        if (feature) {
          this.tileGroup.add(feature.object);
          this.featureMeshes.set(idx, feature);
        }
        if (category !== undefined && PRACTICAL_LAMP_CATEGORIES.has(category)) {
          lampCandidates.push({ x: w.x, z: w.z, idx });
        }
      }
    }
    floor.instanceMatrix.needsUpdate = true;
    if (floor.instanceColor) floor.instanceColor.needsUpdate = true;
    this.tileGroup.add(floor);
    this.floorMesh = floor;

    this.buildPracticalLights(lampCandidates);

    this.buildHelpers();
    if (state.objective) {
      this.updateObjectiveBeaconTarget(state.objective.target);
      this.buildExtractionMarkers(state.objective.extractionZone);
    }
    this.frameSunShadow(grid.width, grid.height);

    // Open close to the deployment zone so units and immediate terrain read
    // clearly. The player can zoom out for the full strategic view.
    const cx = (grid.width - 1) / 2;
    const cz = (grid.height - 1) / 2;
    const deployment = state.units.find((unit) => unit.faction === "player" && unit.alive)?.pos;
    const focusX = deployment?.x ?? cx;
    const focusZ = deployment?.y ?? cz;
    this.controls?.target.set(focusX, 0, focusZ);
    this.camera.position.set(focusX - 7.5, 12.5, focusZ + 13);
    this.desiredTarget.set(focusX, 0, focusZ);
  }

  // -------------------------------------------------------------------------
  // Feature construction (delegated to props.ts; materials cloned per tile)
  // -------------------------------------------------------------------------

  /**
   * Build the raised feature for a tile, or null for flat ground. `variant`
   * (the cellIndex) seeds props.ts's deterministic per-tile variety. Materials
   * are cloned per tile so fog dimming stays local to this tile.
   *
   * Wall / hull / fence / opening tiles are NOT drawn as self-contained boxes:
   * they delegate to {@link ./walls}, which renders a neighbour-aware THIN wall
   * (hub + arms toward adjacent wall tiles) so contiguous tiles fuse into one
   * continuous wall with real corners, tees, crosses, doorways and windows. The
   * sim still treats them as solid — this is render-only.
   */
  private buildTileFeature(
    category: string | undefined,
    variant: number,
    wx: number,
    wz: number,
    x: number,
    y: number,
  ): TileFeature | null {
    if (category === undefined) return null;
    const wall = this.buildWallFeature(category, variant, wx, wz, x, y);
    if (wall) return wall;

    const cover = this.buildCoverFeature(category, variant);
    if (cover) {
      cover.object.position.set(wx, 0, wz);
      return cover;
    }

    const obj = createFeature(category, { variant });
    if (!obj) return null;
    obj.position.set(wx, 0, wz);
    return { object: obj, parts: cloneFeatureMaterials(obj), category };
  }

  /**
   * Build the raised feature for a cover emplacement the renderer owns directly
   * (sandbags = half cover, low_wall = full shoot-over cover). Neither belongs to
   * a wall family nor is a props.ts prop, so they are built here as self-contained
   * obstacles — distinct from full walls (taller, sight-blocking) and open ground.
   * Materials are cloned per tile like props so fog dimming stays local.
   */
  private buildCoverFeature(category: string, variant: number): TileFeature | null {
    let obj: Object3D | null = null;
    if (category === "sandbags") obj = buildSandbags(variant);
    else if (category === "low_wall") obj = buildLowWall(variant);
    if (!obj) return null;
    return { object: obj, parts: cloneFeatureMaterials(obj), category };
  }

  /**
   * Build a neighbour-aware thin wall for a wall / hull / fence / opening tile,
   * or null if the category is not wall-ish. The wall's arms extend only toward
   * the orthogonal neighbours that {@link connectsTo} the resolved family, so
   * adjacent wall tiles meet flush and read as one continuous wall. Materials
   * are cloned per tile (like props) so fog dimming via {@link applyTileVisibility}
   * stays local to this tile.
   */
  private buildWallFeature(
    category: string,
    variant: number,
    wx: number,
    wz: number,
    x: number,
    y: number,
  ): TileFeature | null {
    const opening = openingOf(category);
    const direct = wallFamilyOf(category);
    if (direct === null && opening === "none") return null;

    // An opening-only tile (generic door / window) inherits its family from a
    // connecting wall neighbour; failing that, default by category.
    const family: WallFamily =
      direct ??
      this.inferOpeningFamily(x, y) ??
      (category.startsWith("ufo") ? "ufo" : "building");

    const grid = this.grid;
    const connects = (nx: number, ny: number): boolean => {
      if (!grid) return false;
      const cat = categoryFor(tileTypeAt(grid, nx, ny));
      return cat !== undefined && connectsTo(family, cat);
    };
    const neighbors: WallNeighbors = {
      n: connects(x, y - 1),
      e: connects(x + 1, y),
      s: connects(x, y + 1),
      w: connects(x - 1, y),
      ne: connects(x + 1, y - 1),
      nw: connects(x - 1, y - 1),
      se: connects(x + 1, y + 1),
      sw: connects(x - 1, y + 1),
    };

    const obj = buildWall(family, neighbors, opening, { variant });
    obj.position.set(wx, 0, wz);
    return { object: obj, parts: cloneFeatureMaterials(obj), category };
  }

  /**
   * Resolve the wall family of an opening-only tile from the first orthogonal
   * neighbour whose render category maps to a family (e.g. an interior `door`
   * sitting in a `wall_interior` run becomes `interior`). Null if none does.
   */
  private inferOpeningFamily(x: number, y: number): WallFamily | null {
    const grid = this.grid;
    if (!grid) return null;
    const around: ReadonlyArray<readonly [number, number]> = [
      [x, y - 1],
      [x + 1, y],
      [x, y + 1],
      [x - 1, y],
    ];
    for (const [nx, ny] of around) {
      const cat = categoryFor(tileTypeAt(grid, nx, ny));
      if (cat === undefined) continue;
      const f = wallFamilyOf(cat);
      if (f !== null) return f;
    }
    return null;
  }

  /**
   * Rebuild a single tile's raised feature + floor colour from the current sim
   * state. Disposes the previously built feature (its per-tile cloned materials
   * are owned here) and constructs a fresh one when the tile now has one, so a
   * mid-battle terrain change reads immediately — notably cover destroyed by a
   * grenade (sandbags/low_wall/crate -> a low debris pile via the "rubble"
   * category). Called from {@link syncFromState} when a tile's render category
   * drifts from what it was built for.
   */
  private rebuildTileFeature(x: number, y: number): void {
    const grid = this.grid;
    if (!grid) return;
    const idx = cellIndex(grid, x, y);

    const old = this.featureMeshes.get(idx);
    if (old) {
      this.tileGroup.remove(old.object);
      old.object.traverse((o) => {
        if (o instanceof Mesh) {
          o.geometry.dispose();
          const m = o.material;
          if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
          else m.dispose();
        }
      });
      this.featureMeshes.delete(idx);
    }

    const category = categoryFor(tileTypeAt(grid, x, y));
    const base = new Color(groundToneFor(category));
    this.floorBase[idx] = base;
    if (this.floorMesh) this.floorMesh.setColorAt(idx, base);

    const w = tileToWorld(x, y, 0);
    const feature = this.buildTileFeature(category, idx, w.x, w.z, x, y);
    if (feature) {
      this.tileGroup.add(feature.object);
      this.featureMeshes.set(idx, feature);
    }
  }

  private buildHelpers(): void {
    const ring = new Mesh(
      new RingGeometry(0.48, 0.62, 40),
      new MeshBasicMaterial({ color: COLORS.selectRing, transparent: true, opacity: 0.9 }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.035;
    ring.visible = false;
    this.selectionRing = ring;
    this.scene.add(ring);

    const halo = new Mesh(
      new RingGeometry(0.66, 0.71, 40),
      new MeshBasicMaterial({ color: COLORS.selectRing, transparent: true, opacity: 0.22 }),
    );
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = 0.03;
    halo.visible = false;
    this.selectionHalo = halo;
    this.scene.add(halo);

    // Facing tick: a small teal arrowhead sitting on the selection ring's
    // forward edge, yawed to the selected unit's Dir8 so the player can read
    // which way the soldier is looking at a glance. Flat on the ground; the
    // geometry is pre-translated to the ring radius, pointing north at yaw 0.
    const tickGeo = new ShapeGeometry(facingTickShape());
    tickGeo.translate(0, 0.56, 0);
    tickGeo.rotateX(-Math.PI / 2); // bake the flatten: shape +Y -> world -Z (north)
    const tick = new Mesh(
      tickGeo,
      new MeshBasicMaterial({
        color: COLORS.selectRing,
        transparent: true,
        opacity: 0.95,
        side: DoubleSide,
        depthWrite: false,
      }),
    );
    tick.position.y = 0.045;
    tick.visible = false;
    this.selectionTick = tick;
    this.scene.add(tick);

    const hover = new Mesh(
      new RingGeometry(0.38, 0.48, 32),
      new MeshBasicMaterial({ color: COLORS.hover, transparent: true, opacity: 0.58 }),
    );
    hover.rotation.x = -Math.PI / 2;
    hover.position.y = 0.04;
    hover.visible = false;
    this.hoverMarker = hover;
    this.scene.add(hover);
  }

  /** Point the selection facing tick at a unit's tile + Dir8 (or hide it). */
  private placeSelectionTick(x: number, z: number, facing: number, visible: boolean): void {
    if (!this.selectionTick) return;
    this.selectionTick.visible = visible;
    if (!visible) return;
    this.selectionTick.position.set(x, 0.045, z);
    // Glyph points world -Z at yaw 0; +PI aligns that base direction with the
    // unit's facing vector via dir8ToAngleY.
    this.selectionTick.rotation.y =
      dir8ToAngleY(facing as Parameters<typeof dir8ToAngleY>[0]) + Math.PI;
  }

  /** Mark the known crash-site objective without revealing hostile units. */
  private buildObjectiveBeacon(x: number, z: number): void {
    if (this.objectiveBeacon) this.disposeSceneMarker(this.objectiveBeacon);

    const beacon = new Group();
    beacon.position.set(x, 0, z);
    const inner = new Mesh(
      new RingGeometry(0.72, 0.8, 48),
      new MeshBasicMaterial({
        color: COLORS.selectRing,
        transparent: true,
        opacity: 0.58,
        depthWrite: false,
      }),
    );
    inner.rotation.x = -Math.PI / 2;
    inner.position.y = 0.08;
    const outer = new Mesh(
      new RingGeometry(1.08, 1.12, 48),
      new MeshBasicMaterial({
        color: COLORS.selectRing,
        transparent: true,
        opacity: 0.22,
        depthWrite: false,
      }),
    );
    outer.rotation.x = -Math.PI / 2;
    outer.position.y = 0.07;

    const beamGeometry = new BufferGeometry();
    beamGeometry.setAttribute(
      "position",
      new Float32BufferAttribute([0, 0.12, 0, 0, 3.2, 0], 3),
    );
    const beam = new Line(
      beamGeometry,
      new LineBasicMaterial({
        color: COLORS.selectRing,
        transparent: true,
        opacity: 0.32,
      }),
    );
    beacon.add(inner, outer, beam);
    this.scene.add(beacon);
    this.objectiveBeacon = beacon;
  }

  private buildCarrierBeacon(): void {
    if (this.carrierBeacon) return;

    const beacon = new Group();
    const ring = new Mesh(
      new RingGeometry(0.22, 0.3, 32),
      new MeshBasicMaterial({
        color: COLORS.pathOk,
        transparent: true,
        opacity: 0.78,
        depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 1.72;

    const beamGeometry = new BufferGeometry();
    beamGeometry.setAttribute(
      "position",
      new Float32BufferAttribute([0, 1.38, 0, 0, 2.18, 0], 3),
    );
    const beam = new Line(
      beamGeometry,
      new LineBasicMaterial({
        color: COLORS.pathOk,
        transparent: true,
        opacity: 0.42,
      }),
    );
    beacon.add(ring, beam);
    beacon.visible = false;
    this.scene.add(beacon);
    this.carrierBeacon = beacon;
  }

  private buildExtractionMarkers(tiles: readonly Vec2[]): void {
    if (this.extractionGroup) this.disposeSceneMarker(this.extractionGroup);
    const group = new Group();
    for (const tile of tiles) {
      const w = tileToWorld(tile.x, tile.y, 0);
      const marker = new Mesh(
        new RingGeometry(0.42, 0.5, 32),
        new MeshBasicMaterial({
          color: COLORS.pathOk,
          transparent: true,
          opacity: 0.34,
          depthWrite: false,
        }),
      );
      marker.rotation.x = -Math.PI / 2;
      marker.position.set(w.x, 0.09, w.z);
      group.add(marker);
    }
    group.visible = false;
    this.scene.add(group);
    this.extractionGroup = group;
  }

  private updateObjectiveBeaconTarget(target: Vec2): void {
    const w = tileToWorld(target.x, target.y, 0);
    if (!this.objectiveBeacon) this.buildObjectiveBeacon(w.x, w.z);
    else this.objectiveBeacon.position.set(w.x, 0, w.z);
    this.objectiveBeaconTarget = { x: target.x, y: target.y };
  }

  private syncObjectiveMarkers(state: BattleState): void {
    const objective = state.objective;
    if (!objective) {
      if (this.objectiveBeacon) this.objectiveBeacon.visible = false;
      if (this.carrierBeacon) this.carrierBeacon.visible = false;
      if (this.extractionGroup) this.extractionGroup.visible = false;
      return;
    }

    if (
      !this.objectiveBeaconTarget ||
      this.objectiveBeaconTarget.x !== objective.target.x ||
      this.objectiveBeaconTarget.y !== objective.target.y
    ) {
      this.updateObjectiveBeaconTarget(objective.target);
    }
    if (this.objectiveBeacon) {
      this.objectiveBeacon.visible = !objective.recovered && !objective.extracted;
    }

    if (this.extractionGroup) {
      this.extractionGroup.visible = objective.recovered && !objective.extracted;
    }

    this.buildCarrierBeacon();
    const carrier = objective.recovered && !objective.extracted && objective.recoveredBy !== undefined
      ? state.units.find((unit) => unit.id === objective.recoveredBy && unit.alive)
      : undefined;
    if (carrier && this.carrierBeacon) {
      const w = tileToWorld(carrier.pos.x, carrier.pos.y, 0);
      this.carrierBeacon.position.set(w.x, 0, w.z);
      this.carrierBeacon.visible = true;
    } else if (this.carrierBeacon) {
      this.carrierBeacon.visible = false;
    }
  }

  private createUnitView(unit: Unit): UnitView {
    const root = new Group();

    // Procedural figure: feet at y = 0, local +Z forward (its own forward cue,
    // so the old facing wedge is gone). Rotated by faceView to the unit's Dir8.
    // Civilians get a distinct unarmed, plain-clothes figure so the player can
    // tell who to protect; every other faction uses the shared armed figures.
    const character = unit.faction === "civilian" ? buildCivilianFigure(unit) : createCharacterMesh(unit);
    root.add(character);

    // Floating HP bar (background + fill), billboarded each frame, sat above
    // the head (figures top out around y ≈ 1.4). applyStance lowers it when kneeling.
    const hpBar = new Group();
    hpBar.position.y = HP_BAR_Y;
    const back = new Mesh(
      new PlaneGeometry(HP_BAR_W + 0.06, 0.18),
      new MeshBasicMaterial({ color: COLORS.hpBack }),
    );
    const hpFill = new Mesh(
      new PlaneGeometry(HP_BAR_W, 0.12),
      new MeshBasicMaterial({ color: hpColor(1) }),
    );
    hpFill.position.z = 0.001;
    hpBar.add(back, hpFill);
    root.add(hpBar);

    this.unitGroup.add(root);
    const view: UnitView = { root, character, hpBar, hpFill };
    this.unitViews.set(unit.id, view);
    return view;
  }

  private faceView(view: UnitView, dir: number): void {
    view.character.rotation.y = dir8ToAngleY(dir as Parameters<typeof dir8ToAngleY>[0]);
  }

  private updateHp(view: UnitView, unit: Unit): void {
    const frac = hpFraction(unit.hp, unit.stats.health);
    view.hpFill.scale.x = Math.max(0.0001, frac);
    view.hpFill.position.x = -(1 - frac) * HP_BAR_W * 0.5;
    (view.hpFill.material as MeshBasicMaterial).color.setHex(hpColor(frac));
  }

  /**
   * Reflect a unit's body stance on its figure. Kneeling crouches the mesh
   * (Y-scaled lower about the feet, so the head drops while the feet stay planted)
   * and lowers the HP bar to sit just above the crouched head. Standing resets
   * both. Applied every sync so a live stance change reads immediately. Aiming /
   * walk-pose tweaks live on other transforms (rotation/position), so this scale
   * composes cleanly with them.
   */
  private applyStance(view: UnitView, unit: Unit): void {
    const kneel = (unit.stance ?? "stand") === "kneel";
    view.character.scale.set(1, kneel ? STANCE_KNEEL_SCALE : 1, 1);
    view.hpBar.position.y = kneel ? HP_BAR_Y_KNEEL : HP_BAR_Y;
  }

  /** Capture a figure's per-material base tones once so a KO desaturation can be
   *  applied and later restored exactly (materials are owned per unit view). */
  private captureKoParts(view: UnitView): void {
    if (view.koParts) return;
    const parts: { mat: MeshStandardMaterial; color: Color; emissiveIntensity: number }[] = [];
    view.character.traverse((node) => {
      if (!(node instanceof Mesh)) return;
      const src = node.material;
      const mats: MeshStandardMaterial[] = Array.isArray(src)
        ? src.filter((x): x is MeshStandardMaterial => x instanceof MeshStandardMaterial)
        : src instanceof MeshStandardMaterial
          ? [src]
          : [];
      for (const mat of mats) {
        if (!parts.some((p) => p.mat === mat)) {
          parts.push({ mat, color: mat.color.clone(), emissiveIntensity: mat.emissiveIntensity });
        }
      }
    });
    view.koParts = parts;
  }

  /**
   * Reflect a unit's unconscious (stunned-out) state on its figure: lay the body
   * collapsed onto the ground, sink it slightly, hide the HP bar, and desaturate
   * its materials so a captured alien reads clearly as neutralized. Restores the
   * upright, full-colour figure exactly once if the unit wakes ({@link woke}).
   * Idempotent — driven every sync, but material edits only fire on transition.
   */
  private applyUnconscious(view: UnitView, unit: Unit): void {
    const ko = unit.unconscious === true && unit.alive;
    if (ko) {
      this.captureKoParts(view);
      view.character.rotation.x = 1.42; // folded onto the ground, like a downed body
      view.root.position.y = -0.04;
      view.hpBar.visible = false;
      for (const p of view.koParts ?? []) {
        p.mat.color.copy(p.color).lerp(KO_GREY, 0.6);
        p.mat.emissiveIntensity = p.emissiveIntensity * 0.15;
      }
      view.ko = true;
    } else if (view.ko) {
      view.character.rotation.x = 0;
      view.root.position.y = 0;
      view.hpBar.visible = true;
      for (const p of view.koParts ?? []) {
        p.mat.color.copy(p.color);
        p.mat.emissiveIntensity = p.emissiveIntensity;
      }
      view.ko = false;
    }
  }

  /** Tiles any living player can currently see, as a set of cell indices. */
  private computeVisibleCells(state: BattleState): Set<number> {
    const out = new Set<number>();
    for (const u of state.units) {
      if (u.faction !== "player" || !u.alive) continue;
      for (const t of visibleTiles(state.grid, u)) {
        out.add(cellIndex(state.grid, t.x, t.y));
      }
    }
    return out;
  }

  private applyTileVisibility(idx: number, vis: TileVisibility): void {
    const base = this.floorBase[idx];
    if (!base || !this.floorMesh) return;

    // Floor quad tone by fog state: full when visible, desaturated+dimmed (but
    // legible) when explored, painted the near-black void when never seen.
    if (vis === "visible") {
      this.floorMesh.setColorAt(idx, base);
    } else if (vis === "explored") {
      this.floorMesh.setColorAt(idx, fogExplored(SCRATCH_COLOR, base, EXPLORED_DESAT, EXPLORED_FLOOR_DIM));
    } else {
      this.floorMesh.setColorAt(idx, FOG_VOID);
    }

    const feature = this.featureMeshes.get(idx);
    if (!feature) return;
    // Never-seen structures stay hidden (unexplored ground must read as a true
    // void); known structures are drawn so the map stays continuous, with fog
    // desaturating/dimming the explored ones. Enemy UNITS are hidden separately.
    if (vis === "hidden") {
      feature.object.visible = false;
      return;
    }
    feature.object.visible = true;
    if (vis === "visible") {
      for (const part of feature.parts) {
        part.mat.color.copy(part.base);
        if (part.emissiveBase) part.mat.emissive.copy(part.emissiveBase);
      }
    } else {
      for (const part of feature.parts) {
        fogExplored(part.mat.color, part.base, EXPLORED_DESAT, EXPLORED_FEATURE_DIM);
        if (part.emissiveBase) {
          SCRATCH_COLOR_B.copy(part.emissiveBase).multiplyScalar(EXPLORED_FEATURE_DIM);
          part.mat.emissive.copy(SCRATCH_COLOR_B);
        }
      }
    }
  }

  /** Rebuild/refresh meshes, fog and unit visibility from authoritative state. */
  syncFromState(state: BattleState): void {
    if (!this.floorMesh) this.buildGrid(state);
    this.grid = state.grid;
    // Retune lighting/fog/exposure to the launch hour (day/dusk/night). Runs
    // after buildGrid so the Fog exists on the first sync, and idempotently on
    // every sync thereafter.
    this.applyTimeOfDay(state);

    const visibleCells = this.computeVisibleCells(state);
    // Gate the warm practical pools now that fog visibility is known (day = all
    // off => zero point-light cost; night = only seen lamp tiles glow).
    this.updatePracticalLights(state, visibleCells);
    const cellCount = state.grid.width * state.grid.height;

    // A blast may have destroyed cover since the last sync (a sandbags / low_wall
    // / crate tile swapped to a walkable debris pile). Detect any feature-bearing
    // tile whose render category drifted from the feature we built for it and
    // rebuild that tile's feature + floor colour BEFORE fog dimming, so the new
    // look (a low rubble pile where the obstacle was) reads immediately. Floor
    // tiles never have a featureMeshes entry, so requiring `built` skips them —
    // otherwise every floor tile (grass/road/… all carry a render category) would
    // mismatch null-vs-category and rebuild every sync (O(map) wasted work + a
    // per-tile Color allocation each).
    for (let y = 0; y < state.grid.height; y++) {
      for (let x = 0; x < state.grid.width; x++) {
        const built = this.featureMeshes.get(cellIndex(state.grid, x, y));
        if (
          built &&
          built.category !== (categoryFor(tileTypeAt(state.grid, x, y)) ?? undefined)
        ) {
          this.rebuildTileFeature(x, y);
        }
      }
    }

    for (let i = 0; i < cellCount; i++) {
      this.applyTileVisibility(i, classifyTile(i, visibleCells, state.explored));
    }
    if (this.floorMesh?.instanceColor) this.floorMesh.instanceColor.needsUpdate = true;

    const visEnemies = visibleEnemyIds(state, "player");
    for (const unit of state.units) {
      let view = this.unitViews.get(unit.id);
      if (!view) view = this.createUnitView(unit);
      const w = tileToWorld(unit.pos.x, unit.pos.y, 0);
      view.root.position.set(w.x, 0, w.z);
      view.root.scale.setScalar(1);
      this.faceView(view, unit.facing);
      this.applyStance(view, unit);
      this.updateHp(view, unit);
      // Unconscious (stunned-out) units lie collapsed + desaturated; runs after
      // face/stance/position so it can override the figure's pitch and y-offset.
      this.applyUnconscious(view, unit);
      const shown = unit.alive && (unit.faction === "player" || visEnemies.has(unit.id));
      view.root.visible = shown;
    }

    this.updateSelectionRing(state);
    this.syncObjectiveMarkers(state);
    this.syncSmokeClouds(state);
    this.syncDeployableMarkers(state);
    this.syncCoverEdges(state, visibleCells);
  }

  /**
   * Rebuild the map-wide cover-edge highlights (Track 4 item 2). For each living
   * PLAYER unit, look at its four orthogonal neighbours; where a neighbour tile
   * grants cover, draw a thin teal bar on that cover tile's shared edge (the
   * covered flank), so the player reads at a glance which cover is shielding a
   * soldier. Visual-only — the cover value is read straight from the sim tile
   * data (never mutated). Shared geometry + material are reused; only the
   * per-edge Mesh wrappers churn (the smoke/marker pattern), so nothing here
   * allocates GPU resources per sync or leaks.
   */
  private syncCoverEdges(state: BattleState, visibleCells: ReadonlySet<number>): void {
    for (const child of [...this.coverEdgeGroup.children]) {
      this.coverEdgeGroup.remove(child);
    }
    const grid = state.grid;
    // [neighbour dx, dz, edge world offset x, z, bar yaw]. The bar lies on the
    // shared edge between the unit and the cover tile, running along that edge.
    const sides: ReadonlyArray<readonly [number, number, number, number, number]> = [
      [0, -1, 0, -0.5, 0], // N: cover to -Z, bar runs along X
      [1, 0, 0.5, 0, Math.PI / 2], // E: cover to +X, bar runs along Z
      [0, 1, 0, 0.5, 0], // S
      [-1, 0, -0.5, 0, Math.PI / 2], // W
    ];
    for (const unit of state.units) {
      if (unit.faction !== "player" || !unit.alive) continue;
      const w = tileToWorld(unit.pos.x, unit.pos.y, 0);
      for (const [dx, dz, ox, oz, yaw] of sides) {
        const nx = unit.pos.x + dx;
        const ny = unit.pos.y + dz;
        if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height) continue;
        const cover = tileTypeAt(grid, nx, ny)?.cover ?? 0;
        if (cover <= 0) continue;
        // Never disclose a cover object on a never-seen tile: the fog hides its
        // feature mesh and voids its floor, so a bar there would leak its
        // location. Only draw on tiles that are visible or previously explored.
        const nIdx = cellIndex(grid, nx, ny);
        if (!visibleCells.has(nIdx) && !state.explored.has(nIdx)) continue;
        // Dual-code the flank by cover strength: amber = half, blue = full.
        const mat = cover >= 2 ? this.coverEdgeFullMaterial : this.coverEdgeHalfMaterial;
        const bar = new Mesh(this.coverEdgeGeometry, mat);
        bar.rotation.y = yaw; // geometry is already flat; orient along the edge
        bar.position.set(w.x + ox, 0.06, w.z + oz);
        this.coverEdgeGroup.add(bar);
      }
    }
  }

  /**
   * Rebuild the smoke-cloud visuals from state. Each cloud renders as a small
   * cluster of overlapping translucent spheres (a billowing read) scaled to the
   * cloud's Chebyshev radius and lifted just above the ground. The shared
   * geometry/material are reused; only the per-cloud meshes are rebuilt.
   */
  private syncSmokeClouds(state: BattleState): void {
    for (const child of [...this.smokeGroup.children]) {
      this.smokeGroup.remove(child);
    }
    const clouds = state.smokeClouds;
    if (!clouds || clouds.length === 0) return;
    for (const cloud of clouds) {
      const w = tileToWorld(cloud.pos.x, cloud.pos.y, 0);
      const r = cloud.radius + 0.5;
      const cluster = new Group();
      const main = new Mesh(this.smokeGeometry, this.smokeMaterial);
      main.scale.setScalar(r);
      cluster.add(main);
      const puffA = new Mesh(this.smokeGeometry, this.smokeMaterial);
      puffA.scale.setScalar(r * 0.6);
      puffA.position.set(r * 0.4, 0.2, -r * 0.3);
      cluster.add(puffA);
      const puffB = new Mesh(this.smokeGeometry, this.smokeMaterial);
      puffB.scale.setScalar(r * 0.55);
      puffB.position.set(-r * 0.35, -0.1, r * 0.4);
      cluster.add(puffB);
      cluster.position.set(w.x, 0.5, w.z);
      this.smokeGroup.add(cluster);
    }
  }

  /**
   * Rebuild the deployable-item markers from state. Each planted proximity mine
   * renders as a small emissive red dot lifted just above its tile; each unit
   * with an active scanner reveal gets a faint flattened cyan pad on the ground
   * sized to its scan radius (a best-effort pulse — no animation). The shared
   * geometry/material are reused; only the per-deployable meshes are rebuilt.
   */
  private syncDeployableMarkers(state: BattleState): void {
    for (const child of [...this.markerGroup.children]) {
      this.markerGroup.remove(child);
    }
    const mines = state.mines;
    if (mines) {
      for (const mine of mines) {
        const w = tileToWorld(mine.pos.x, mine.pos.y, 0);
        const dot = new Mesh(this.markerGeometry, this.mineMaterial);
        dot.scale.setScalar(0.22);
        dot.position.set(w.x, 0.35, w.z);
        this.markerGroup.add(dot);
      }
    }
    for (const u of state.units) {
      if (!u.alive || !u.scanRadius || u.scanRadius <= 0) continue;
      const w = tileToWorld(u.pos.x, u.pos.y, 0);
      const r = u.scanRadius + 0.5;
      const pad = new Mesh(this.markerGeometry, this.scannerMaterial);
      // Flattened sphere => a thin glowing disc reading as the scan area.
      pad.scale.set(r, 0.06, r);
      pad.position.set(w.x, 0.04, w.z);
      this.markerGroup.add(pad);
    }
  }

  private updateSelectionRing(state: BattleState): void {
    if (!this.selectionRing) return;
    if (this.selectedId === null) {
      this.selectionRing.visible = false;
      if (this.selectionHalo) this.selectionHalo.visible = false;
      this.placeSelectionTick(0, 0, 0, false);
      return;
    }
    const unit = state.units.find((u) => u.id === this.selectedId);
    if (!unit || !unit.alive) {
      this.selectionRing.visible = false;
      if (this.selectionHalo) this.selectionHalo.visible = false;
      this.placeSelectionTick(0, 0, 0, false);
      return;
    }
    const w = tileToWorld(unit.pos.x, unit.pos.y, 0);
    this.selectionRing.position.set(w.x, 0.02, w.z);
    this.selectionRing.visible = true;
    if (this.selectionHalo) {
      this.selectionHalo.position.set(w.x, 0.02, w.z);
      this.selectionHalo.visible = true;
    }
    this.placeSelectionTick(w.x, w.z, unit.facing, true);
  }

  // -------------------------------------------------------------------------
  // Selection / hover / previews
  // -------------------------------------------------------------------------

  setSelected(id: UnitId | null): void {
    this.selectedId = id;
    if (id === null) {
      if (this.selectionRing) this.selectionRing.visible = false;
      if (this.selectionHalo) this.selectionHalo.visible = false;
      this.placeSelectionTick(0, 0, 0, false);
      this.clearCoverIndicators();
    }
    if (id !== null) {
      const view = this.unitViews.get(id);
      if (view && this.selectionRing) {
        this.selectionRing.position.set(view.root.position.x, 0.02, view.root.position.z);
        this.selectionRing.visible = view.root.visible;
        if (this.selectionHalo) {
          this.selectionHalo.position.set(view.root.position.x, 0.02, view.root.position.z);
          this.selectionHalo.visible = view.root.visible;
        }
        // Follow the ring, and reorient to THIS unit's facing now — selecting a
        // unit does not dispatch/sync, so without this the tick would keep the
        // previously-selected unit's yaw and misreport the vision cone. The
        // figure was already rotated to its Dir8 (faceView: character.rotation.y
        // = dir8ToAngleY(facing)); the tick's glyph points world -Z, so +PI
        // aligns it with that same facing.
        if (this.selectionTick) {
          this.selectionTick.position.set(view.root.position.x, 0.045, view.root.position.z);
          this.selectionTick.rotation.y = view.character.rotation.y + Math.PI;
          this.selectionTick.visible = view.root.visible;
        }
      }
    }
  }

  setHoverTile(tile: Vec2 | null): void {
    if (!this.hoverMarker) return;
    if (!tile) {
      this.hoverMarker.visible = false;
      return;
    }
    const w = tileToWorld(tile.x, tile.y, 0);
    this.hoverMarker.position.set(w.x, 0.03, w.z);
    this.hoverMarker.visible = true;
  }

  showPathPreview(path: Vec2[]): void {
    this.disposeGroupChildren(this.previewGroup);
    const geo = new PlaneGeometry(0.5, 0.5);
    for (const tile of path) {
      const dot = new Mesh(
        geo,
        new MeshBasicMaterial({ color: COLORS.pathOk, transparent: true, opacity: 0.7 }),
      );
      dot.rotation.x = -Math.PI / 2;
      const w = tileToWorld(tile.x, tile.y, 0);
      dot.position.set(w.x, 0.04, w.z);
      this.previewGroup.add(dot);
    }
  }

  showAimLine(from: Vec2, to: Vec2): void {
    this.disposeGroupChildren(this.previewGroup);
    const a = tileToWorld(from.x, from.y, 0.8);
    const b = tileToWorld(to.x, to.y, 0.8);
    const geo = new BufferGeometry();
    geo.setAttribute(
      "position",
      new Float32BufferAttribute([a.x, a.y, a.z, b.x, b.y, b.z], 3),
    );
    const line = new Line(geo, new LineBasicMaterial({ color: COLORS.aim }));
    this.previewGroup.add(line);
  }

  clearPreview(): void {
    this.disposeGroupChildren(this.previewGroup);
    this.setHoverTile(null);
  }

  // -------------------------------------------------------------------------
  // Directional cover indicators (selected player unit)
  // -------------------------------------------------------------------------

  /**
   * Draw small shield markers on the four cardinal edges of the selected player
   * unit's tile, one per adjacent tile that grants cover, so the player can read
   * which flanks are protected. Cover 1 (half) shows a short half-shield glyph in
   * amber; cover 2 (full) shows a taller full-shield glyph in blue. The SHAPE
   * differs as well as the tint, so the cue is never colour-alone. Pass null (or
   * a non-player unit) to clear. Cheap: one small group refreshed in place and
   * disposed properly on clear/teardown.
   */
  showCoverIndicators(unit: Unit | null): void {
    if (!this.coverIndicatorGroup) {
      this.coverIndicatorGroup = new Group();
      this.scene.add(this.coverIndicatorGroup);
    }
    this.disposeGroupChildren(this.coverIndicatorGroup);

    if (!unit || unit.faction !== "player" || !this.grid) {
      this.coverIndicatorGroup.visible = false;
      return;
    }

    // [edgeOffsetX, edgeOffsetZ, neighbourX, neighbourY, outwardFacingAngleY].
    // The marker sits on the shared tile edge and faces AWAY from the unit, so it
    // reads as "cover on this flank". The neighbour's tile cover is what shields
    // a shot coming from that direction.
    const sides: ReadonlyArray<readonly [number, number, number, number, number]> = [
      [0, -0.5, unit.pos.x, unit.pos.y - 1, Math.PI], // N (-Z)
      [0.5, 0, unit.pos.x + 1, unit.pos.y, Math.PI / 2], // E (+X)
      [0, 0.5, unit.pos.x, unit.pos.y + 1, 0], // S (+Z)
      [-0.5, 0, unit.pos.x - 1, unit.pos.y, -Math.PI / 2], // W (-X)
    ];
    const w = tileToWorld(unit.pos.x, unit.pos.y, 0);
    let any = false;
    for (const [dx, dz, nx, ny, angle] of sides) {
      if (nx < 0 || ny < 0 || nx >= this.grid.width || ny >= this.grid.height) continue;
      const cover = tileTypeAt(this.grid, nx, ny)?.cover ?? 0;
      if (cover <= 0) continue;
      any = true;
      const marker = this.buildCoverMarker(cover);
      marker.position.set(w.x + dx, 0.05, w.z + dz);
      marker.rotation.y = angle;
      this.coverIndicatorGroup.add(marker);
    }
    this.coverIndicatorGroup.visible = any;
  }

  /** Remove every cover marker (called on deselect / teardown / re-show). */
  clearCoverIndicators(): void {
    if (!this.coverIndicatorGroup) return;
    this.disposeGroupChildren(this.coverIndicatorGroup);
    this.coverIndicatorGroup.visible = false;
  }

  /**
   * One shield marker for a cover value: a flat glyph standing on the tile edge,
   * facing outward. Full cover = a taller, pointed-bottom shield (blue); half
   * cover = a shorter, flat-bottom half-shield (amber). depthTest off + high
   * renderOrder so the marker stays readable even when the adjacent cover prop
   * would otherwise occlude it; the basic (unlit) material keeps it bright.
   */
  private buildCoverMarker(cover: number): Mesh {
    const full = cover >= 2;
    const shape = full ? fullShieldShape() : halfShieldShape();
    const geo = new ShapeGeometry(shape);
    geo.translate(0, full ? 0.3 : 0.02, 0); // rest the glyph's base at local y = 0
    const mat = new MeshBasicMaterial({
      color: full ? COLORS.coverFull : COLORS.coverHalf,
      transparent: true,
      opacity: 0.92,
      side: DoubleSide,
      depthTest: false,
      depthWrite: false,
    });
    const mesh = new Mesh(geo, mat);
    mesh.renderOrder = 999;
    return mesh;
  }

  private disposeGroupChildren(group: Group): void {
    for (const child of [...group.children]) {
      group.remove(child);
      if (child instanceof Mesh || child instanceof Line) {
        child.geometry.dispose();
        const mat = child.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat.dispose();
      }
    }
  }

  private disposeSceneMarker(marker: Group): void {
    this.scene.remove(marker);
    this.disposeGroupChildren(marker);
  }

  /** Release a standalone helper mesh (selection ring / halo / hover marker). */
  private disposeSceneMesh(mesh: Mesh): void {
    this.scene.remove(mesh);
    mesh.geometry.dispose();
    const mat = mesh.material;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat.dispose();
  }

  // -------------------------------------------------------------------------
  // Raycasting
  // -------------------------------------------------------------------------

  private setPointer(clientX: number, clientY: number): boolean {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return true;
  }

  raycastTile(clientX: number, clientY: number): Vec2 | null {
    if (!this.groundPlane || !this.grid) return null;
    if (!this.setPointer(clientX, clientY)) return null;
    const hits = this.raycaster.intersectObject(this.groundPlane, false);
    const hit = hits[0];
    if (!hit) return null;
    const x = Math.round(hit.point.x) + 0;
    const y = Math.round(hit.point.z) + 0;
    if (x < 0 || y < 0 || x >= this.grid.width || y >= this.grid.height) return null;
    return { x, y };
  }

  raycastUnit(clientX: number, clientY: number): UnitId | null {
    if (!this.setPointer(clientX, clientY)) return null;
    const figures: Group[] = [];
    for (const view of this.unitViews.values()) {
      if (view.root.visible) figures.push(view.character);
    }
    // Recursive: every descendant of a figure carries userData.unitId.
    const hits = this.raycaster.intersectObjects(figures, true);
    const hit = hits[0];
    if (!hit) return null;
    const data = hit.object.userData as { unitId?: UnitId };
    return data.unitId ?? null;
  }

  // -------------------------------------------------------------------------
  // Camera focus
  // -------------------------------------------------------------------------

  focusOn(tile: Vec2): void {
    const w = tileToWorld(tile.x, tile.y, 0);
    this.desiredTarget.set(w.x, 0, w.z);
    this.panActive = true;
  }

  // -------------------------------------------------------------------------
  // Event animations (awaitable, robust, ~150ms)
  // -------------------------------------------------------------------------

  async playMoveStep(ev: Extract<GameEvent, { type: "moveStep" }>): Promise<void> {
    const view = this.unitViews.get(ev.unitId);
    if (!view) return;
    view.root.visible = true;
    view.root.scale.setScalar(1);
    this.faceView(view, ev.facing);
    const from = tileToWorld(ev.from.x, ev.from.y, 0);
    const to = tileToWorld(ev.to.x, ev.to.y, 0);
    await tween(MOVE_TWEEN_MS, (t) => {
      setCharacterWalkPose(view.character, t);
      view.root.position.set(lerp(from.x, to.x, t), 0, lerp(from.z, to.z, t));
    });
    setCharacterWalkPose(view.character, 0, 0);
    view.root.position.set(to.x, 0, to.z);
    if (this.selectedId === ev.unitId) this.setSelected(ev.unitId);
  }

  async playShot(ev: Extract<GameEvent, { type: "shot" }>, kind: ProjectileKind): Promise<void> {
    const shooter = this.unitViews.get(ev.shooterId);
    if (shooter) {
      shooter.root.visible = true; // reveal the source of fire
      this.faceView(shooter, dirTowards(shooter.root.position, ev.targetPos));
      setCharacterPose(shooter.character, { aiming: true });
    }
    // Gunfire does NOT shake the camera (Track 4 item 6 — explosions only).
    const target = ev.targetId != null ? this.unitViews.get(ev.targetId) ?? null : null;
    // Bullets originate from the tile the sim actually fired from: the shooter's
    // tile for a direct shot, or the lean tile for a corner peek (so a peek
    // shot's tracers don't visually pass through the wall it's hugging).
    const origin = tileToWorld(ev.originPos.x, ev.originPos.y, 0);
    const tw = tileToWorld(ev.targetPos.x, ev.targetPos.y, 0);
    const muzzle = new Vector3(origin.x, 1, origin.z);
    const muzzleNode = shooter?.character.getObjectByName("weaponMuzzle");
    if (shooter && muzzleNode) {
      shooter.character.updateWorldMatrix(true, true);
      muzzleNode.getWorldPosition(muzzle);
      // Corner-peek shots originate from an adjacent tile in the simulation.
      muzzle.x += origin.x - shooter.root.position.x;
      muzzle.z += origin.z - shooter.root.position.z;
    }

    try {
      await this.effects.fireVolley({
        from: muzzle,
        to: new Vector3(tw.x, 0.9, tw.z),
        rounds: ev.rounds.map((r) => ({ hit: r.hit, deviationRad: r.deviationRad })),
        kind,
      });
      // Damage feedback on the target: red emissive flash + flinch, only when a
      // round connected and the target is currently on screen (no fog leak).
      if (target && target.root.visible && ev.rounds.some((r) => r.hit)) {
        await this.playHitReaction(target);
      }
    } finally {
      if (shooter) setCharacterPose(shooter.character, { aiming: false });
    }
  }

  /**
   * Brief damage feedback on a unit that was just hit: a quick red emissive
   * flush over its figure plus a small flinch (scale pulse + recoil pitch) that
   * eases back over ~200ms. Presentation-only — the sim has already applied the
   * damage. Materials + emissive baselines are captured once at the start and
   * restored exactly on completion, so the figure is untouched afterwards and
   * composes cleanly with stance/death animations.
   */
  private async playHitReaction(view: UnitView): Promise<void> {
    const saved: { mat: MeshStandardMaterial; emissive: Color; intensity: number }[] = [];
    view.character.traverse((node) => {
      if (!(node instanceof Mesh)) return;
      const src = node.material;
      const mats: MeshStandardMaterial[] = Array.isArray(src)
        ? src.filter((x): x is MeshStandardMaterial => x instanceof MeshStandardMaterial)
        : src instanceof MeshStandardMaterial
          ? [src]
          : [];
      for (const mat of mats) {
        if (!saved.some((s) => s.mat === mat)) {
          saved.push({ mat, emissive: mat.emissive.clone(), intensity: mat.emissiveIntensity });
        }
      }
    });

    const baseScale = view.root.scale.x || 1;
    await tween(HIT_REACT_MS, (t) => {
      // Snap then relax: strong at impact, eased back to neutral by the end.
      const flash = Math.max(0, 1 - t * 1.5);
      view.root.scale.setScalar(baseScale + flash * 0.06);
      view.character.rotation.x = flash * 0.16;
      for (const s of saved) {
        s.mat.emissive.copy(s.emissive).lerp(HIT_RED, flash);
        s.mat.emissiveIntensity = s.intensity + flash * 2.0;
      }
    });
    for (const s of saved) {
      s.mat.emissive.copy(s.emissive);
      s.mat.emissiveIntensity = s.intensity;
    }
    view.root.scale.setScalar(baseScale);
    view.character.rotation.x = 0;
  }

  async playDeath(ev: Extract<GameEvent, { type: "died" }>): Promise<void> {
    const view = this.unitViews.get(ev.unitId);
    if (!view) return;
    view.root.visible = true;
    view.root.scale.setScalar(1);
    // Ragdoll-ish collapse: pitch forward about the feet, sink and flatten as
    // the body folds to the ground. Eased-out so the fall has weight.
    await tween(DEATH_COLLAPSE_MS, (t) => {
      const e = 1 - Math.pow(1 - t, 3);
      view.character.rotation.x = e * 1.42; // pitch forward ~80deg onto the ground
      view.root.position.y = -e * 0.06; // sink as the body folds down
      view.root.scale.setScalar(1 - e * 0.1);
    });
    view.root.visible = false;
    view.root.position.y = 0;
    view.root.scale.setScalar(1);
    view.character.rotation.x = 0;
    if (this.selectedId === ev.unitId) this.setSelected(null);
  }

  /**
   * Stun-rod strike feedback on the target: a quick electric-cyan emissive flush
   * over the figure plus a jittery shake (the "electric jolt"), and a floating
   * stun number that rises and fades above its head — styled in electric cyan so
   * it reads distinctly from the red damage flash. Presentation-only. A knockout
   * lets the ensuing syncFromState collapse + desaturate the (now unconscious)
   * figure via {@link applyUnconscious}, so this call just sells the hit.
   */
  async playStunStrike(ev: Extract<GameEvent, { type: "stunStrike" }>): Promise<void> {
    const view = this.unitViews.get(ev.targetId);
    if (!view || !view.root.visible) return;
    this.floatStunNumber(
      new Vector3(view.root.position.x, HP_BAR_Y + 0.3, view.root.position.z),
      ev.stun,
      ev.knockedOut === true,
    );
    // A stun strike no longer shakes the camera (explosions only, item 6); the
    // electric jitter on the target figure below carries the impact instead.

    const saved: { mat: MeshStandardMaterial; emissive: Color; intensity: number }[] = [];
    view.character.traverse((node) => {
      if (!(node instanceof Mesh)) return;
      const src = node.material;
      const mats: MeshStandardMaterial[] = Array.isArray(src)
        ? src.filter((x): x is MeshStandardMaterial => x instanceof MeshStandardMaterial)
        : src instanceof MeshStandardMaterial
          ? [src]
          : [];
      for (const mat of mats) {
        if (!saved.some((s) => s.mat === mat)) {
          saved.push({ mat, emissive: mat.emissive.clone(), intensity: mat.emissiveIntensity });
        }
      }
    });
    const baseZ = view.character.rotation.z;
    await tween(STUN_REACT_MS, (t) => {
      const flash = Math.max(0, 1 - t);
      // Buzzing electric jitter: a fast sign-flipping wobble that decays out.
      view.character.rotation.z = baseZ + Math.sin(t * 48) * 0.12 * flash;
      for (const s of saved) {
        s.mat.emissive.copy(s.emissive).lerp(STUN_CYAN, flash);
        s.mat.emissiveIntensity = s.intensity + flash * 2.4;
      }
    });
    // Restore emissive; leave rotation.z at the KO-agnostic base (syncFromState
    // re-derives the figure's transform, and applyUnconscious owns the collapse).
    for (const s of saved) {
      s.mat.emissive.copy(s.emissive);
      s.mat.emissiveIntensity = s.intensity;
    }
    view.character.rotation.z = baseZ;
  }

  /** Spawn a short-lived billboarded number sprite that rises and fades above a
   *  world point. Used for the stun readout; cyan-tinted (brighter on a KO) so it
   *  never reads as the (never-drawn) damage number. Self-disposes on completion. */
  private floatStunNumber(worldPos: Vector3, value: number, knockedOut: boolean): void {
    const label = knockedOut ? `${value} ⚡ KO` : `+${value}`;
    const texture = makeTextTexture(label, knockedOut ? "#b8ffff" : "#8fe4ff");
    const material = new SpriteMaterial({ map: texture, transparent: true, depthTest: false });
    const sprite = new Sprite(material);
    sprite.scale.set(knockedOut ? 2.0 : 1.4, knockedOut ? 0.5 : 0.35, 1);
    sprite.position.copy(worldPos);
    sprite.renderOrder = 999;
    this.fxGroup.add(sprite);
    const startY = worldPos.y;
    void tween(STUN_FLOAT_MS, (t) => {
      sprite.position.y = startY + t * 1.1;
      material.opacity = 1 - t * t;
    }).then(() => {
      this.fxGroup.remove(sprite);
      texture.dispose();
      material.dispose();
    });
  }

  /**
   * Detonation animation for a grenade/HE blast: convert the tile centre to
   * world coords (raised slightly so the flash reads above the ground) and
   * hand off to {@link Effects.playBlast}, awaiting its full lifetime so the
   * controller can sequence the ensuing damage/visibility reveal afterwards.
   */
  async playBlast(center: Vec2, radius: number): Promise<void> {
    const w = tileToWorld(center.x, center.y, 0);
    this.addShake(SHAKE_BLAST); // explosion concussion (the only screen shake)
    await this.effects.playBlast(new Vector3(w.x, 0.4, w.z), radius);
  }

  /**
   * Throw-arc indicator for a thrown item (grenade, …): a glowing projectile
   * that arcs from one tile to another. Awaitable so the controller can fire
   * the detonation FX only once it has landed.
   */
  async playThrowArc(from: Vec2, to: Vec2): Promise<void> {
    const a = tileToWorld(from.x, from.y, 0.9);
    const b = tileToWorld(to.x, to.y, 0.4);
    await this.effects.playThrowArc(new Vector3(a.x, a.y, a.z), new Vector3(b.x, b.y, b.z));
  }

  /** Read-only access for the controller (e.g. to pan to a unit's mesh). */
  unitWorldTile(id: UnitId): Vec2 | null {
    const view = this.unitViews.get(id);
    if (!view) return null;
    return { x: Math.round(view.root.position.x), y: Math.round(view.root.position.z) };
  }

  /** Tear down GPU resources: terrain, every unit figure, the HP bars and FX. */
  dispose(): void {
    this.effects.dispose();
    for (const view of this.unitViews.values()) {
      disposeCharacter(view.character);
      this.disposeGroupChildren(view.hpBar);
      this.unitGroup.remove(view.root);
    }
    this.unitViews.clear();
    if (this.objectiveBeacon) {
      this.disposeSceneMarker(this.objectiveBeacon);
      this.objectiveBeacon = null;
      this.objectiveBeaconTarget = null;
    }
    if (this.carrierBeacon) {
      this.disposeSceneMarker(this.carrierBeacon);
      this.carrierBeacon = null;
    }
    if (this.extractionGroup) {
      this.disposeSceneMarker(this.extractionGroup);
      this.extractionGroup = null;
    }
    if (this.coverIndicatorGroup) {
      this.disposeSceneMarker(this.coverIndicatorGroup);
      this.coverIndicatorGroup = null;
    }
    // Persistent helper meshes from buildHelpers(): each owns its own
    // RingGeometry + MeshBasicMaterial, so dispose them explicitly (they are
    // not Group markers and so are not covered by disposeSceneMarker above).
    if (this.selectionRing) {
      this.disposeSceneMesh(this.selectionRing);
      this.selectionRing = null;
    }
    if (this.selectionHalo) {
      this.disposeSceneMesh(this.selectionHalo);
      this.selectionHalo = null;
    }
    if (this.selectionTick) {
      this.disposeSceneMesh(this.selectionTick);
      this.selectionTick = null;
    }
    if (this.hoverMarker) {
      this.disposeSceneMesh(this.hoverMarker);
      this.hoverMarker = null;
    }
    this.disposeGrid();
    // Smoke clouds: clear the per-cloud meshes and release the shared resources
    // owned here (the geometry + material are not part of the shared cache).
    for (const child of [...this.smokeGroup.children]) {
      this.smokeGroup.remove(child);
    }
    this.smokeGeometry.dispose();
    this.smokeMaterial.dispose();
    // Deployable-item markers (mines + scanner pulses): same pattern.
    for (const child of [...this.markerGroup.children]) {
      this.markerGroup.remove(child);
    }
    this.markerGeometry.dispose();
    this.mineMaterial.dispose();
    this.scannerMaterial.dispose();
    // Cover-edge highlights: clear the per-edge wrappers and release the shared
    // geometry + material owned here (same pattern as smoke/markers).
    for (const child of [...this.coverEdgeGroup.children]) {
      this.coverEdgeGroup.remove(child);
    }
    this.coverEdgeGeometry.dispose();
    this.coverEdgeHalfMaterial.dispose();
    this.coverEdgeFullMaterial.dispose();
    // Release the shared material/texture/env cache after the per-tile clones
    // (above) are gone, then the composer's render targets.
    disposeMaterials();
    this.composer.dispose();

    // Tear down the WebGL stack itself. This view is the one 3D surface that
    // previously leaked these on every battle: OrbitControls' document-level
    // pointer listeners (only controls.dispose() detaches them), the live
    // WebGL context (browsers cap ~16 per process — forceContextLoss frees the
    // slot so the next battle gets a fresh one), and the appended canvas node.
    // Matches the lifecycle in geoscape.ts / planeCombatView.ts, plus an
    // explicit context release because a new Renderer is built each mission.
    const canvas = this.renderer.domElement;
    if (this.onContextLost) canvas.removeEventListener("webglcontextlost", this.onContextLost);
    if (this.onContextRestored) canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    this.onContextLost = null;
    this.onContextRestored = null;
    this.controls?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.container?.removeChild(canvas);
    this.container = null;
  }

  /** Release the floor InstancedMesh, the ground plane and every tile feature. */
  private disposeGrid(): void {
    if (this.floorMesh) {
      this.floorMesh.geometry.dispose();
      // The floor material is the SHARED getFloorMaterial() instance (owned by
      // materials.ts / disposeMaterials) — do NOT dispose it here.
      this.floorMesh.dispose();
      this.tileGroup.remove(this.floorMesh);
      this.floorMesh = null;
    }
    for (const feature of this.featureMeshes.values()) {
      // Feature materials are per-tile CLONES owned here, so disposing them is
      // correct (and never touches the shared cache).
      feature.object.traverse((obj) => {
        if (obj instanceof Mesh) {
          obj.geometry.dispose();
          const mat = obj.material;
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
          else mat.dispose();
        }
      });
      this.tileGroup.remove(feature.object);
    }
    this.featureMeshes.clear();
    this.floorBase.length = 0;
    // Warm practical pools are built per grid; release them with it.
    for (const { light } of this.practicalLights) {
      this.scene.remove(light);
      light.dispose();
    }
    this.practicalLights.length = 0;
    if (this.groundPlane) {
      this.groundPlane.geometry.dispose();
      (this.groundPlane.material as MeshStandardMaterial).dispose();
      this.scene.remove(this.groundPlane);
      this.groundPlane = null;
    }
  }
}

/** Nearest Dir8 from a world XZ position toward a target tile (for shot facing). */
function dirTowards(world: Vector3, target: Vec2): number {
  const dx = target.x - world.x;
  const dy = target.y - world.z;
  const dirs: ReadonlyArray<readonly [number, number]> = [
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
  ];
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return 0;
  const angle = Math.atan2(dy, dx);
  let best = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < dirs.length; i++) {
    const v = dirs[i]!;
    let d = Math.abs(angle - Math.atan2(v[1], v[0]));
    while (d > Math.PI) d = Math.abs(d - 2 * Math.PI);
    if (d < bestDiff) {
      bestDiff = d;
      best = i;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Cover-indicator shield glyphs (flat shapes in the XY plane, normal +Z)
// ---------------------------------------------------------------------------

/** A small arrowhead (points toward shape +Y) — the selection facing tick. */
function facingTickShape(): Shape {
  const s = new Shape();
  s.moveTo(0, 0.16);
  s.lineTo(-0.12, -0.06);
  s.lineTo(0.12, -0.06);
  s.closePath();
  return s;
}

/** Full shield outline (rounded shoulders, pointed bottom) — the full-cover glyph. */
function fullShieldShape(): Shape {
  const s = new Shape();
  s.moveTo(0, 0.26);
  s.quadraticCurveTo(0.2, 0.26, 0.2, 0.1);
  s.lineTo(0.2, -0.04);
  s.quadraticCurveTo(0.2, -0.22, 0, -0.3);
  s.quadraticCurveTo(-0.2, -0.22, -0.2, -0.04);
  s.lineTo(-0.2, 0.1);
  s.quadraticCurveTo(-0.2, 0.26, 0, 0.26);
  return s;
}

/** Top half of the shield (flat bottom near the equator) — the half-cover glyph. */
function halfShieldShape(): Shape {
  const s = new Shape();
  s.moveTo(0, 0.26);
  s.quadraticCurveTo(0.2, 0.26, 0.2, 0.1);
  s.lineTo(0.2, -0.02);
  s.lineTo(-0.2, -0.02);
  s.lineTo(-0.2, 0.1);
  s.quadraticCurveTo(-0.2, 0.26, 0, 0.26);
  return s;
}
