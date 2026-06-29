/**
 * Procedural tile-feature geometry.
 *
 * Presentation-only (three.js). For every RAISED render category that is NOT a
 * wall (a tree, crate, rock, the alien deck plate, …) {@link createFeature}
 * builds a real, shaped low-poly object: footprint inside one tile (~0.9 wide),
 * BASE sitting on the ground at y = 0, origin at the tile centre, ready for the
 * renderer to drop at world (gx, gy).
 *
 * Wall / hull / fence / door / window tiles are NOT built here: they are
 * neighbour-aware THIN walls that fuse across tiles, so the renderer routes them
 * to {@link ./walls} instead. This module only owns self-contained tile props.
 *
 * Pure-flat ground categories (grass, road, and similar) and unknown categories
 * return `null` — the renderer draws those as instanced floor quads.
 *
 * Materials come from {@link ./materials} (shared, cached PBR instances), so a
 * feature does NOT own them; {@link disposeFeature} releases only the
 * geometry. Everything is deterministic: any per-tile variety is derived from
 * `opts.variant` (a stable seed the renderer passes per tile), never from
 * `Math.random`, so the look is identical across runs and never desyncs.
 */

import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  Mesh,
  SphereGeometry,
  TorusGeometry,
  type BufferGeometry,
  type MeshStandardMaterial,
  type Object3D,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import { getEmissiveMaterial, getTerrainMaterial } from "./materials";

// ---------------------------------------------------------------------------
// Determinism: a small seeded PRNG (variant -> stable jitter, no Math.random)
// ---------------------------------------------------------------------------

const TWO_PI = Math.PI * 2;
const HALF_PI = Math.PI / 2;

/** Deterministic PRNG seeded by a feature's variant. Same seed -> same stream. */
function rngFor(variant: number): () => number {
  let a = (Math.imul(variant | 0, 0x9e3779b1) ^ 0x6d2b79f5) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic hash of a 3D direction -> [0,1] (crack-free vertex deform). */
function hash3(x: number, y: number, z: number, seed: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + seed * 13.13) * 43758.5453;
  return s - Math.floor(s);
}

// ---------------------------------------------------------------------------
// Accent palette (emissive colours that trip bloom; see materials EMISSIVE_*)
// ---------------------------------------------------------------------------

const GLOW = {
  ufo: 0x6ee7ff, // cyan alien running lights / rim
  ufoDoor: 0x39d6c0, // teal hatch glow
  window: 0xffce82, // warm lit interior window
  dropship: 0xff8a3c, // amber human-tech trim
} as const;

// ---------------------------------------------------------------------------
// Mesh helpers
// ---------------------------------------------------------------------------

/** A solid, shadow-casting/receiving mesh (the default for structural surfaces). */
function solid(geometry: BufferGeometry, material: MeshStandardMaterial): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** A decorative accent (emissive trim / translucent pane): no shadow interaction. */
function accent(geometry: BufferGeometry, material: MeshStandardMaterial): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

/** Merge a batch of placed geometries into one (and dispose the sources). */
function mergePlaced(geometries: BufferGeometry[]): BufferGeometry {
  const merged = mergeGeometries(geometries, false);
  for (const g of geometries) g.dispose();
  return merged;
}

// ---------------------------------------------------------------------------
// UFO deck (the alien floor; the hull wall lives in walls.ts)
// ---------------------------------------------------------------------------

/** A thin metallic deck plate with a faint emissive inlay (walkable alien floor). */
function buildUfoFloor(): Group {
  const group = new Group();

  // Octagonal deck plate (8-sided cylinder), kept very low so units read as
  // standing on it.
  const plate = solid(new CylinderGeometry(0.47, 0.47, 0.04, 8), getTerrainMaterial("ufo_floor"));
  plate.rotation.y = Math.PI / 8; // flats face the tile edges
  plate.position.y = 0.02;
  group.add(plate);

  // A faint glowing inlay ring on top.
  const ring = accent(new TorusGeometry(0.3, 0.018, 6, 28), getEmissiveMaterial(GLOW.ufo, 1.4));
  ring.rotation.x = HALF_PI;
  ring.position.y = 0.045;
  group.add(ring);

  return group;
}

// ---------------------------------------------------------------------------
// Vegetation
// ---------------------------------------------------------------------------

/** Trunk + layered canopy. Even variants = conifer cones; odd = broadleaf blobs. */
function buildTree(variant: number): Group {
  const group = new Group();
  const rng = rngFor(variant);

  const trunk = solid(new CylinderGeometry(0.1, 0.14, 0.6, 7), getTerrainMaterial("floor_wood"));
  trunk.position.y = 0.3;
  trunk.rotation.y = rng() * TWO_PI;
  group.add(trunk);

  const foliageMat = getTerrainMaterial("tree");
  const spin = rng() * TWO_PI;

  if ((variant & 1) === 0) {
    // Conifer: three stacked cones, each a touch jittered in size/height.
    const layers: ReadonlyArray<readonly [number, number, number]> = [
      [0.42, 0.62, 0.82],
      [0.33, 0.56, 1.14],
      [0.22, 0.46, 1.44],
    ];
    for (const [r, h, y] of layers) {
      const j = 0.92 + rng() * 0.16;
      const cone = solid(new ConeGeometry(r * j, h, 9), foliageMat);
      cone.position.y = y;
      cone.rotation.y = spin;
      group.add(cone);
    }
  } else {
    // Broadleaf: a clump of squashed spheres forming a rounded crown.
    const blobs: ReadonlyArray<readonly [number, number, number, number]> = [
      [0.0, 1.0, 0.0, 0.42],
      [0.2, 0.86, 0.06, 0.3],
      [-0.16, 0.9, -0.1, 0.28],
    ];
    for (const [dx, y, dz, r] of blobs) {
      const j = 0.9 + rng() * 0.2;
      const blob = solid(new SphereGeometry(r * j, 10, 8), foliageMat);
      blob.scale.set(1, 0.85, 1);
      blob.position.set(dx, y, dz);
      group.add(blob);
    }
  }

  return group;
}

/** A clipped hedge: a low body with a rounded (domed) top. */
function buildHedge(): Group {
  const group = new Group();
  const mat = getTerrainMaterial("hedge");

  const body = solid(new BoxGeometry(0.88, 0.42, 0.88), mat);
  body.position.y = 0.21;
  group.add(body);

  const dome = solid(new SphereGeometry(0.5, 12, 8, 0, TWO_PI, 0, HALF_PI), mat);
  dome.scale.set(0.92, 0.5, 0.92);
  dome.position.y = 0.42;
  group.add(dome);

  return group;
}

/** A small leafy bush: a couple of squashed icospheres. */
function buildBush(variant: number): Group {
  const group = new Group();
  const rng = rngFor(variant);
  const mat = getTerrainMaterial("bush");

  const main = solid(new IcosahedronGeometry(0.33, 1), mat);
  main.scale.set(1, 0.78, 1);
  main.position.y = 0.26;
  main.rotation.y = rng() * TWO_PI;
  group.add(main);

  const a = rng() * TWO_PI;
  const side = solid(new IcosahedronGeometry(0.22, 1), mat);
  side.scale.set(1, 0.8, 1);
  side.position.set(Math.cos(a) * 0.2, 0.2, Math.sin(a) * 0.2);
  group.add(side);

  return group;
}

// ---------------------------------------------------------------------------
// Cover / scatter
// ---------------------------------------------------------------------------

/** A reinforced crate: a wooden panel box wrapped in a darker merged edge frame. */
function buildCrate(): Group {
  const group = new Group();

  const panel = solid(new BoxGeometry(0.58, 0.58, 0.58), getTerrainMaterial("crate"));
  panel.position.y = 0.3;
  group.add(panel);

  // Corner posts + top/bottom rails, merged into a single framed mesh.
  const beams: BufferGeometry[] = [];
  const s = 0.31; // half-extent of the frame footprint
  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      const post = new BoxGeometry(0.08, 0.62, 0.08);
      post.translate(s * sx, 0.31, s * sz);
      beams.push(post);
    }
  }
  for (const y of [0.02, 0.6]) {
    for (const sz of [-1, 1] as const) {
      const rail = new BoxGeometry(0.62, 0.07, 0.07);
      rail.translate(0, y, s * sz);
      beams.push(rail);
      const railZ = new BoxGeometry(0.07, 0.07, 0.62);
      railZ.translate(s * sz, y, 0);
      beams.push(railZ);
    }
  }
  const frame = solid(mergePlaced(beams), getTerrainMaterial("fence"));
  group.add(frame);

  return group;
}

/** An upright drum with banding rings top and bottom. */
function buildBarrel(): Group {
  const group = new Group();
  const mat = getTerrainMaterial("barrel");

  const body = solid(new CylinderGeometry(0.26, 0.26, 0.6, 14), mat);
  body.position.y = 0.3;
  group.add(body);

  for (const y of [0.12, 0.3, 0.48]) {
    const ring = solid(new TorusGeometry(0.27, 0.022, 6, 18), mat);
    ring.rotation.x = HALF_PI;
    ring.position.y = y;
    group.add(ring);
  }

  return group;
}

/** A low scatter of broken chunks (deterministic from variant), merged to one mesh. */
function buildRubble(variant: number): Group {
  const group = new Group();
  const rng = rngFor(variant);

  const chunks: BufferGeometry[] = [];
  const count = 4;
  for (let i = 0; i < count; i++) {
    const size = 0.18 + rng() * 0.16;
    const h = 0.12 + rng() * 0.16;
    const g = new BoxGeometry(size, h, size);
    g.rotateY(rng() * TWO_PI);
    g.translate((rng() - 0.5) * 0.5, h * 0.5, (rng() - 0.5) * 0.5);
    chunks.push(g);
  }
  group.add(solid(mergePlaced(chunks), getTerrainMaterial("rubble")));

  return group;
}

/** A noise-deformed icosahedron boulder, flat-shaded (per-face normals). */
/**
 * A deformed icosahedral boulder (flat-shaded). Shared by rock and the arctic
 * ice_block so a glacial block reuses the proven boulder silhouette and only the
 * material (category) differs. `variant` seeds deterministic per-tile jitter.
 */
function buildBoulder(variant: number, category: string): Group {
  const group = new Group();
  const geo = new IcosahedronGeometry(0.42, 1);
  const pos = geo.attributes.position;
  if (pos) {
    const seed = (variant % 997) + 1;
    let minY = Infinity;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const len = Math.hypot(x, y, z) || 1;
      // Hash the NORMALIZED direction so duplicated verts deform identically.
      const n = hash3(x / len, y / len, z / len, seed);
      const f = 1 + (n - 0.5) * 0.42;
      pos.setXYZ(i, x * f, y * f * 0.82, z * f);
      minY = Math.min(minY, pos.getY(i));
    }
    // Drop so the lowest vertex rests on the ground.
    for (let i = 0; i < pos.count; i++) pos.setY(i, pos.getY(i) - minY);
    pos.needsUpdate = true;
  }
  // Non-indexed geometry -> these become per-face normals = flat-shaded look.
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  group.add(solid(geo, getTerrainMaterial(category)));
  return group;
}

function buildRock(variant: number): Group {
  return buildBoulder(variant, "rock");
}

/** A solid glacial block (arctic full cover): the boulder silhouette in ice. */
function buildIceBlock(variant: number): Group {
  return buildBoulder(variant, "ice_block");
}

/** A fallen log (jungle/forest half cover): a short trunk laid on its side. */
function buildLog(): Group {
  const group = new Group();
  const geo = new CylinderGeometry(0.22, 0.22, 0.9, 10);
  geo.rotateZ(HALF_PI); // lay the length along X
  geo.translate(0, 0.22, 0); // rest the curve on the ground
  group.add(solid(geo, getTerrainMaterial("log")));
  return group;
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Build the raised feature object for a non-wall render category, or `null` for
 * flat ground / wall / unknown categories (the renderer draws flat ground as
 * floor quads and routes wall / hull / fence / door / window tiles through
 * {@link ./walls}). The returned object's base sits at y = 0, centred on the
 * tile origin — place it at world (x = gx, z = gy). `opts.variant` seeds
 * deterministic per-tile variety (trees, rocks, rubble, …).
 */
export function createFeature(category: string, opts?: { variant?: number }): Object3D | null {
  const variant = opts?.variant ?? 0;
  switch (category) {
    case "ufo_floor":
      return buildUfoFloor();
    case "tree":
      return buildTree(variant);
    case "rock":
      return buildRock(variant);
    case "ice_block":
      return buildIceBlock(variant);
    case "log":
      return buildLog();
    case "hedge":
      return buildHedge();
    case "bush":
      return buildBush(variant);
    case "crate":
      return buildCrate();
    case "barrel":
      return buildBarrel();
    case "rubble":
      return buildRubble(variant);
    // Flat ground (grass, soil, crop, road, pavement, sand, floor_wood,
    // floor_concrete, dropship_floor), wall-family
    // tiles (walls.ts) and unknown categories have no prop here.
    default:
      return null;
  }
}

/**
 * Release a feature's GPU geometry. Materials are SHARED/cached by
 * {@link ./materials} (or cloned + owned by the renderer for per-tile fog
 * dimming), so they are intentionally NOT disposed here.
 */
export function disposeFeature(obj: Object3D): void {
  obj.traverse((node) => {
    if (node instanceof Mesh) node.geometry.dispose();
  });
}
