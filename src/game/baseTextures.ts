/**
 * Frozen Layer 1 — the shared PROCEDURAL visual vocabulary for the base. Every
 * architectural surface in the base (walls, floors, racks, vats, screens,
 * props) traces its textures+materials here so the facility reads as CRAFTED
 * game art, not programmer primitives. All-original: every texture is painted
 * on a 2D canvas at module scope, then wrapped as a PBR MeshStandardMaterial
 * (albedo map + matching normal map for surface relief, or an emissive screen).
 *
 * Palette discipline: solid tints come from {@link BASE_PALETTE}; canvas pixel
 * colors are steel/concrete neutrals + facility accents that harmonize with it.
 *
 * CACHING (dispose-safe): the canvases are expensive to paint, so each texture
 * pair and each material is built ONCE and held at module scope for the life of
 * the page. Callers do NOT dispose these — they are shared (e.g. many racks share
 * one panel texture, many figures share one helmet material). The interior dive
 * tears down its OWN per-instance geometries; the shared cached materials travel
 * across builds untouched. {@link disposeBaseTextures} exists for a full final
 * teardown if a host ever needs to reclaim the (small, bounded) GPU memory.
 */
import {
  CanvasTexture,
  ClampToEdgeWrapping,
  Color,
  MeshStandardMaterial,
  NoColorSpace,
  RepeatWrapping,
  SRGBColorSpace,
  Vector2,
} from "three";
import { BASE_PALETTE } from "./basePalette";

/** An albedo/colour canvas paired with its derived relief (normal) canvas. */
export interface TexturePair {
  /** sRGB albedo (colour) texture. */
  readonly map: CanvasTexture;
  /** Linear tangent-space normal map derived from a heightmap. */
  readonly normalMap: CanvasTexture;
}

export interface MetalPanelOptions {
  /** PBR metalness (default 0.6 — brushed structural steel). */
  readonly metalness?: number;
  /** PBR roughness (default 0.5). */
  readonly roughness?: number;
}

// ---------------------------------------------------------------------------
// 2D canvas helpers
// ---------------------------------------------------------------------------

interface CanvasCtx {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
}

/** Create a square canvas + a non-null 2D context (throws if 2D is unavailable). */
function createCanvas(size: number): CanvasCtx {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Failed to acquire 2D canvas context for base textures");
  return { canvas, ctx };
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** Add monochrome film-grain noise directly into a canvas's pixel buffer. */
function addNoise(ctx: CanvasRenderingContext2D, size: number, amount: number): void {
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() * amount * 2 - amount) | 0;
    d[i] = clampByte(d[i]! + n);
    d[i + 1] = clampByte(d[i + 1]! + n);
    d[i + 2] = clampByte(d[i + 2]! + n);
  }
  ctx.putImageData(img, 0, 0);
}

interface Pt {
  x: number;
  y: number;
}

/** Trace a polyline onto a context (single stroke, one colour/width). */
function strokePoints(
  ctx: CanvasRenderingContext2D,
  pts: readonly Pt[],
  color: string,
  width: number,
): void {
  if (pts.length === 0) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
  ctx.stroke();
}

/** Generate a jagged crack as a point list, branching outward from a seed. */
function genCrack(sx: number, sy: number, dir: number, len: number): Pt[] {
  const pts: Pt[] = [{ x: sx, y: sy }];
  let x = sx;
  let y = sy;
  let a = dir;
  for (let s = 0; s < len; s++) {
    x += Math.cos(a);
    y += Math.sin(a);
    a += (Math.random() - 0.5) * 0.7;
    pts.push({ x, y });
  }
  return pts;
}

/**
 * Convert a greyscale heightmap canvas into a tangent-space normal map (RGBA).
 * Wraps at the edges so the result tiles seamlessly with RepeatWrapping. The
 * Sobel-ish gradient gives rivets/grooves/scratches correct directional relief.
 */
function heightToNormal(src: HTMLCanvasElement, strength: number): HTMLCanvasElement {
  const w = src.width;
  const h = src.height;
  const sctx = src.getContext("2d");
  if (!sctx) throw new Error("Failed to acquire 2D canvas context for normal map");
  const srcBytes = sctx.getImageData(0, 0, w, h).data;
  const out = createCanvas(w).canvas;
  const octx = out.getContext("2d")!;
  const outImg = octx.createImageData(w, h);
  const od = outImg.data;
  const sample = (x: number, y: number): number => {
    const xx = ((x % w) + w) % w;
    const yy = ((y % h) + h) % h;
    return srcBytes[(yy * w + xx) * 4]! / 255;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (sample(x - 1, y) - sample(x + 1, y)) * strength;
      const dy = (sample(x, y - 1) - sample(x, y + 1)) * strength;
      const dz = 1;
      const len = Math.hypot(dx, dy, dz);
      const o = (y * w + x) * 4;
      od[o] = (dx / len) * 0.5 + 0.5;
      od[o + 1] = (dy / len) * 0.5 + 0.5;
      od[o + 2] = (dz / len) * 0.5 + 0.5;
      od[o + 3] = 255;
    }
  }
  octx.putImageData(outImg, 0, 0);
  return out;
}

/** Wrap a painted canvas as a configured CanvasTexture (repeat + anisotropy). */
function toTexture(canvas: HTMLCanvasElement, srgb: boolean, repeat = true): CanvasTexture {
  const tex = new CanvasTexture(canvas);
  tex.wrapS = repeat ? RepeatWrapping : ClampToEdgeWrapping;
  tex.wrapT = repeat ? RepeatWrapping : ClampToEdgeWrapping;
  tex.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Raw canvas painters (albedo + height; normal is derived from height)
// ---------------------------------------------------------------------------

interface AlbedoHeight {
  readonly albedo: HTMLCanvasElement;
  readonly height: HTMLCanvasElement;
}

/** Riveted structural-steel PANEL: panel-line grooves, rivet rows, grime. */
function paintMetalPanel(size: number): AlbedoHeight {
  const albedo = createCanvas(size);
  const g = albedo.ctx;
  // Base steel tone (neutral enough to tint via material.color; harmonizes with BASE_PALETTE.steel).
  g.fillStyle = "#5a626e";
  g.fillRect(0, 0, size, size);
  // Vertical sheen so the metal isn't flat.
  const sheen = g.createLinearGradient(0, 0, 0, size);
  sheen.addColorStop(0, "rgba(126,140,158,0.20)");
  sheen.addColorStop(0.5, "rgba(0,0,0,0)");
  sheen.addColorStop(1, "rgba(0,0,0,0.24)");
  g.fillStyle = sheen;
  g.fillRect(0, 0, size, size);

  const cols = 4;
  const rows = 2;
  const groove = Math.max(3, Math.round(size * 0.006));
  // Panel-line grooves (recessed seams).
  g.strokeStyle = "#2a3038";
  g.lineWidth = groove;
  for (let c = 0; c <= cols; c++) {
    const x = (size / cols) * c;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, size);
    g.stroke();
  }
  for (let r = 0; r <= rows; r++) {
    const y = (size / rows) * r;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(size, y);
    g.stroke();
  }
  // Rivets: a bright cap with a dark underside → reads as a raised dome.
  const step = Math.round(size / 28);
  const drawRivet = (x: number, y: number): void => {
    const rad = Math.max(1.6, size * 0.0026);
    g.fillStyle = "#8b94a4";
    g.beginPath();
    g.arc(x, y, rad, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#363e48";
    g.beginPath();
    g.arc(x + rad * 0.3, y + rad * 0.4, rad * 0.62, 0, Math.PI * 2);
    g.fill();
  };
  for (let c = 0; c <= cols; c++) {
    const x = (size / cols) * c;
    for (let y = step / 2; y < size; y += step) drawRivet(x, y);
  }
  for (let r = 0; r <= rows; r++) {
    const y = (size / rows) * r;
    for (let x = step / 2; x < size; x += step) drawRivet(x, y);
  }
  // Grime streaks (dust/drip runs) + a touch of noise.
  for (let i = 0; i < 70; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const h = 40 + Math.random() * (size * 0.22);
    g.strokeStyle = `rgba(18,22,28,${0.04 + Math.random() * 0.09})`;
    g.lineWidth = 1 + Math.random() * 2;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + (Math.random() * 4 - 2), y + h);
    g.stroke();
  }
  addNoise(g, size, 12);

  // Heightmap: mid-grey base, dark grooves (recessed), bright rivets (raised).
  const heightC = createCanvas(size);
  const hg = heightC.ctx;
  hg.fillStyle = "#808080";
  hg.fillRect(0, 0, size, size);
  hg.strokeStyle = "#1c1c1c";
  hg.lineWidth = groove;
  for (let c = 0; c <= cols; c++) {
    const x = (size / cols) * c;
    hg.beginPath();
    hg.moveTo(x, 0);
    hg.lineTo(x, size);
    hg.stroke();
  }
  for (let r = 0; r <= rows; r++) {
    const y = (size / rows) * r;
    hg.beginPath();
    hg.moveTo(0, y);
    hg.lineTo(size, y);
    hg.stroke();
  }
  const hrad = Math.max(2, size * 0.0032);
  const hRivet = (x: number, y: number): void => {
    hg.fillStyle = "#d8d8d8";
    hg.beginPath();
    hg.arc(x, y, hrad, 0, Math.PI * 2);
    hg.fill();
  };
  for (let c = 0; c <= cols; c++) {
    const x = (size / cols) * c;
    for (let y = step / 2; y < size; y += step) hRivet(x, y);
  }
  for (let r = 0; r <= rows; r++) {
    const y = (size / rows) * r;
    for (let x = step / 2; x < size; x += step) hRivet(x, y);
  }
  return { albedo: albedo.canvas, height: heightC.canvas };
}

/** Cracked CONCRETE: mottled slab with meandering cracks and surface pits. */
function paintConcrete(size: number): AlbedoHeight {
  const albedo = createCanvas(size);
  const g = albedo.ctx;
  g.fillStyle = `#${new Color(BASE_PALETTE.concrete).getHexString()}`;
  g.fillRect(0, 0, size, size);
  // Mottled patches — lighter dust + darker damp, reads as worn concrete.
  for (let i = 0; i < 160; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 20 + Math.random() * 80;
    const light = Math.random() < 0.5;
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, light ? "rgba(64,70,80,0.28)" : "rgba(10,12,16,0.34)");
    rg.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = rg;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  // Cracks onto the albedo (near-black) so their colour reads.
  const cracks: Pt[][] = [];
  for (let i = 0; i < 16; i++) {
    cracks.push(
      genCrack(Math.random() * size, Math.random() * size, Math.random() * Math.PI * 2, 24 + Math.random() * 70),
    );
  }
  for (const pts of cracks) strokePoints(g, pts, "rgba(8,9,12,0.85)", 1 + Math.random() * 1.6);
  addNoise(g, size, 9);

  // Heightmap: subtle surface pits + the cracks as deep grooves.
  const heightC = createCanvas(size);
  const hg = heightC.ctx;
  hg.fillStyle = "#808080";
  hg.fillRect(0, 0, size, size);
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 10 + Math.random() * 40;
    const v = 110 + ((Math.random() * 50) | 0);
    hg.fillStyle = `rgba(${v},${v},${v},0.22)`;
    hg.beginPath();
    hg.arc(x, y, r, 0, Math.PI * 2);
    hg.fill();
  }
  for (const pts of cracks) strokePoints(hg, pts, "#050505", 1.4 + Math.random() * 1.2);
  return { albedo: albedo.canvas, height: heightC.canvas };
}

/** WORN STEEL: brushed horizontal streaks, scoring scratches, rust blooms. */
function paintWornSteel(size: number): AlbedoHeight {
  const albedo = createCanvas(size);
  const g = albedo.ctx;
  g.fillStyle = "#4a525c";
  g.fillRect(0, 0, size, size);
  // Brushed horizontal streaks — the signature of worn plate.
  for (let i = 0; i < 220; i++) {
    const y = Math.random() * size;
    const len = 60 + Math.random() * (size * 0.45);
    const x = Math.random() * size - len / 2;
    const v = 150 + ((Math.random() * 70) | 0);
    g.strokeStyle = `rgba(${v},${v + 6},${v + 18},${0.05 + Math.random() * 0.12})`;
    g.lineWidth = 0.5 + Math.random() * 1.5;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + len, y);
    g.stroke();
  }
  // Heightmap base + scoring scratches (shared geometry drawn onto both layers).
  const heightC = createCanvas(size);
  const hg = heightC.ctx;
  hg.fillStyle = "#808080";
  hg.fillRect(0, 0, size, size);
  for (let i = 0; i < 30; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const len = 30 + Math.random() * 80;
    const a = (Math.random() - 0.5) * 0.3;
    const pts: Pt[] = [{ x, y }];
    for (let s = 0; s < len; s++) pts.push({ x: x + Math.cos(a) * s, y: y + Math.sin(a) * s });
    strokePoints(g, pts, `rgba(10,12,16,${0.3 + Math.random() * 0.4})`, 0.6 + Math.random() * 1.2);
    strokePoints(hg, pts, "#161616", 1.1);
  }
  // Rust / heat discoloration blooms (warm, radial).
  for (let i = 0; i < 22; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 8 + Math.random() * 26;
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, `rgba(124,82,48,${0.1 + Math.random() * 0.16})`);
    rg.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = rg;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  addNoise(g, size, 11);
  return { albedo: albedo.canvas, height: heightC.canvas };
}

/**
 * EMISSIVE SCREEN: dark face + accent grid + bar-graph readout + label text +
 * scanlines + blips. Used as BOTH map and emissiveMap so the readouts glow.
 */
function paintScreen(size: number, color: number, label: string): HTMLCanvasElement {
  const { canvas, ctx: g } = createCanvas(size);
  const hex = new Color(color).getHexString();
  g.fillStyle = "#04070b";
  g.fillRect(0, 0, size, size);
  // Faint accent grid.
  g.strokeStyle = `#${hex}`;
  g.globalAlpha = 0.1;
  g.lineWidth = 1;
  const grid = size / 16;
  for (let x = 0; x <= size; x += grid) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, size);
    g.stroke();
  }
  for (let y = 0; y <= size; y += grid) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(size, y);
    g.stroke();
  }
  g.globalAlpha = 1;
  // Bar-graph readout across the lower middle.
  const bars = 16;
  const barW = (size * 0.84) / bars;
  const baseY = size * 0.55;
  const colH = size * 0.32;
  g.fillStyle = `#${hex}`;
  for (let i = 0; i < bars; i++) {
    const bh = (0.12 + Math.abs(Math.sin(i * 1.3)) * 0.88) * colH;
    g.globalAlpha = 0.85;
    g.fillRect(size * 0.08 + i * barW, baseY + (colH - bh), barW - 3, bh);
  }
  g.globalAlpha = 1;
  // Label + status text in the accent colour.
  g.fillStyle = `#${hex}`;
  g.textBaseline = "top";
  if (label) {
    g.font = `bold ${Math.round(size * 0.06)}px monospace`;
    g.globalAlpha = 0.95;
    g.fillText(label, size * 0.06, size * 0.07);
  }
  g.font = `${Math.round(size * 0.038)}px monospace`;
  g.globalAlpha = 0.72;
  g.fillText("● REC", size * 0.06, size * 0.2);
  g.fillText("SCAN 98%", size * 0.62, size * 0.07);
  g.globalAlpha = 1;
  // Scanlines + a few bright blips for a live feel.
  g.fillStyle = "#000";
  g.globalAlpha = 0.18;
  for (let y = 0; y < size; y += 3) g.fillRect(0, y, size, 1);
  g.globalAlpha = 1;
  g.fillStyle = `#${hex}`;
  for (let i = 0; i < 6; i++) {
    g.globalAlpha = 0.5 + Math.random() * 0.5;
    g.beginPath();
    g.arc(Math.random() * size, Math.random() * size, 1.5 + Math.random() * 2.5, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
  return canvas;
}

// ---------------------------------------------------------------------------
// Cached texture pairs (module scope — built lazily on first use, then shared)
// ---------------------------------------------------------------------------

let panelPair: TexturePair | null = null;
let concretePair: TexturePair | null = null;
let wornPair: TexturePair | null = null;
const screenTexCache = new Map<string, CanvasTexture>();

/** Shared riveted metal-panel textures (albedo + normal). Built once. */
export function metalPanelTextures(): TexturePair {
  if (!panelPair) {
    const { albedo, height } = paintMetalPanel(1024);
    panelPair = {
      map: toTexture(albedo, true),
      normalMap: toTexture(heightToNormal(height, 2.2), false),
    };
  }
  return panelPair;
}

/** Shared cracked-concrete textures (albedo + normal). Built once. */
export function concreteTextures(): TexturePair {
  if (!concretePair) {
    const { albedo, height } = paintConcrete(1024);
    concretePair = {
      map: toTexture(albedo, true),
      normalMap: toTexture(heightToNormal(height, 2.4), false),
    };
  }
  return concretePair;
}

/** Shared worn-steel textures (albedo + normal). Built once. */
export function wornSteelTextures(): TexturePair {
  if (!wornPair) {
    const { albedo, height } = paintWornSteel(512);
    wornPair = {
      map: toTexture(albedo, true),
      normalMap: toTexture(heightToNormal(height, 2.0), false),
    };
  }
  return wornPair;
}

/** Emissive screen canvas texture for an accent colour + optional label. Cached. */
export function screenTexture(color: number, label?: string): CanvasTexture {
  const key = `${color.toString(16)}|${label ?? ""}`;
  let tex = screenTexCache.get(key);
  if (!tex) {
    tex = toTexture(paintScreen(512, color, label?.trim() ?? ""), true, false);
    screenTexCache.set(key, tex);
  }
  return tex;
}

// ---------------------------------------------------------------------------
// Material factories (cached, shared, never disposed by consumers)
// ---------------------------------------------------------------------------

const panelMatCache = new Map<string, MeshStandardMaterial>();
const screenMatCache = new Map<string, MeshStandardMaterial>();
const accentMatCache = new Map<string, MeshStandardMaterial>();
let concreteMat: MeshStandardMaterial | null = null;
let wornMat: MeshStandardMaterial | null = null;

/**
 * Riveted metal-panel PBR material. `tint` (a palette hex) multiplies the
 * neutral steel albedo; default (no tint) shows the panel's own steel tone.
 * Metalness/roughness overridable for darker structural variants.
 */
export function metalPanelMaterial(tint?: number, opts?: MetalPanelOptions): MeshStandardMaterial {
  const metalness = opts?.metalness ?? 0.6;
  const roughness = opts?.roughness ?? 0.5;
  const color = tint ?? 0xffffff;
  const key = `${color.toString(16)}|${metalness}|${roughness}`;
  let m = panelMatCache.get(key);
  if (!m) {
    const tex = metalPanelTextures();
    m = new MeshStandardMaterial({
      map: tex.map,
      normalMap: tex.normalMap,
      normalScale: new Vector2(0.7, 0.7),
      color,
      metalness,
      roughness,
    });
    panelMatCache.set(key, m);
  }
  return m;
}

/** Matte cracked-concrete PBR material (floors / heavy walls). Built once. */
export function concreteMaterial(): MeshStandardMaterial {
  if (!concreteMat) {
    const tex = concreteTextures();
    concreteMat = new MeshStandardMaterial({
      map: tex.map,
      normalMap: tex.normalMap,
      normalScale: new Vector2(0.7, 0.7),
      color: 0xffffff,
      metalness: 0.0,
      roughness: 0.95,
    });
  }
  return concreteMat;
}

/** Worn brushed-steel PBR material (props, frames, machinery). Built once. */
export function wornSteelMaterial(): MeshStandardMaterial {
  if (!wornMat) {
    const tex = wornSteelTextures();
    wornMat = new MeshStandardMaterial({
      map: tex.map,
      normalMap: tex.normalMap,
      normalScale: new Vector2(0.65, 0.65),
      color: 0xffffff,
      metalness: 0.7,
      roughness: 0.55,
    });
  }
  return wornMat;
}

/**
 * EMISSIVE readout SCREEN material: dark face with a glowing accent-colour
 * grid/bar-graph/label (map and emissiveMap share the canvas, so the readouts
 * glow). `color` is a facility accent hex; `label` is drawn at the top.
 */
export function screenMaterial(color: number, label?: string): MeshStandardMaterial {
  const key = `${color.toString(16)}|${label ?? ""}`;
  let m = screenMatCache.get(key);
  if (!m) {
    const tex = screenTexture(color, label);
    m = new MeshStandardMaterial({
      map: tex,
      emissiveMap: tex,
      emissive: new Color(color),
      color: 0xffffff,
      emissiveIntensity: 1.25,
      metalness: 0.1,
      roughness: 0.35,
    });
    screenMatCache.set(key, m);
  }
  return m;
}

/**
 * Solid EMISSIVE accent material in a facility's signature colour — work-light
 * strips, status beacons, reactor fluid. `intensity` controls the glow
 * (0.45 subtle → 2.8 a bright beacon). PBR-tuned (matches basePalette.accentMaterial).
 */
export function accentEmissive(color: number, intensity = 1.0): MeshStandardMaterial {
  const key = `${color.toString(16)}|${intensity}`;
  let m = accentMatCache.get(key);
  if (!m) {
    m = new MeshStandardMaterial({
      color: new Color(color),
      emissive: new Color(color),
      emissiveIntensity: intensity,
      metalness: 0.2,
      roughness: 0.4,
    });
    accentMatCache.set(key, m);
  }
  return m;
}

/**
 * Tear down every cached texture and material. Only needed for a full host
 * teardown that wants to reclaim GPU memory; normal operation never calls this
 * (the caches are page-lifetime shared resources). Safe to call repeatedly.
 */
export function disposeBaseTextures(): void {
  for (const m of panelMatCache.values()) disposeMaterial(m);
  for (const m of screenMatCache.values()) disposeMaterial(m);
  for (const m of accentMatCache.values()) disposeMaterial(m);
  panelMatCache.clear();
  screenMatCache.clear();
  accentMatCache.clear();
  if (concreteMat) {
    disposeMaterial(concreteMat);
    concreteMat = null;
  }
  if (wornMat) {
    disposeMaterial(wornMat);
    wornMat = null;
  }
  panelPair?.map.dispose();
  panelPair?.normalMap.dispose();
  concretePair?.map.dispose();
  concretePair?.normalMap.dispose();
  wornPair?.map.dispose();
  wornPair?.normalMap.dispose();
  for (const t of screenTexCache.values()) t.dispose();
  panelPair = null;
  concretePair = null;
  wornPair = null;
  screenTexCache.clear();
}

/** Dispose a material and any textures bound to its standard map slots. */
function disposeMaterial(m: MeshStandardMaterial): void {
  const slots: (keyof MeshStandardMaterial)[] = ["map", "normalMap", "emissiveMap"];
  for (const key of slots) {
    const tex = m[key] as CanvasTexture | null | undefined;
    tex?.dispose();
  }
  m.dispose();
}
