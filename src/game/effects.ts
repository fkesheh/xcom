/**
 * Visible projectile + impact FX for shots — presentation only.
 *
 * The {@link Effects} class spawns transient, additive-blended tracers / energy
 * bolts that travel from a shooter's muzzle along each round's actual bearing,
 * spark on impact (hits stop at the target; misses fly downrange), and clean
 * themselves up. Everything is procedural geometry; nothing is loaded.
 *
 * This lives in src/game (the presentation layer) so it MAY use three.js and
 * wall-clock timing: determinism is irrelevant to visuals, so the internal
 * requestAnimationFrame loop drives on {@link performance.now}. The sim never
 * sees any of this.
 */

import {
  AdditiveBlending,
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  RingGeometry,
  SphereGeometry,
  Vector3,
} from "three";
import type { Object3D } from "three";

export type ProjectileKind = "rifle" | "pistol" | "plasma";

/** One resolved round to draw. `deviationRad` rotates the bearing about world Y. */
export interface VolleyRound {
  hit: boolean;
  deviationRad: number;
}

export interface FireVolleyOptions {
  from: Vector3;
  to: Vector3;
  rounds: VolleyRound[];
  kind: ProjectileKind;
}

// ---------------------------------------------------------------------------
// Tunables (all presentation-only, in world units / milliseconds).
// ---------------------------------------------------------------------------

const STAGGER_MS = 40; // gap between successive rounds (burst feel)
// Muzzle flash is a hard 2-frame pop (bright frame -> dimmer frame -> gone),
// not a smooth swell: a stylised "flash" reads punchier than an eased fade.
const MUZZLE_FLASH_MS = 56;
const MUZZLE_FRAME_MS = MUZZLE_FLASH_MS / 2; // duration of each of the 2 frames
const IMPACT_FLASH_MS = 130;
const MISS_EXTRA = 4.5; // tiles a miss continues past the target
const MAX_TRAVEL = 28; // hard cap so strays never shoot to infinity
const EPS = 1e-6;

// Impact sparks: a small fan of embers thrown back off the surface a round hits.
const IMPACT_SPARKS = 5;
const IMPACT_SPARK_MS = 200; // sparks outlive the flash, then the round ends
const IMPACT_SPARK_GRAVITY = 7.5;

// Blast (grenade detonation) tuning — radius comes from the sim's blastRadius.
const BLAST_MS = 760; // total effect lifetime (extended so the smoke can linger)
const BLAST_CORE_COLOR = 0xffe9b0; // hot white-yellow centre
const BLAST_SHOCK_COLOR = 0xff7a2a; // ground shockwave ring
const BLAST_SPARK_COLOR = 0xffd070; // ballistic embers
const BLAST_SPARKS = 12;
// Slow smoke: cool-dark puffs that rise, swell and fade after the flash. Drawn
// with normal (not additive) blending so they READ as dark against the field.
const BLAST_SMOKE = 4;
const BLAST_SMOKE_COLOR = 0x23272e;

// Throw-arc indicator tuning (a thrown grenade's travel cue).
const THROW_COLOR = 0xffd479;
const THROW_MS_MIN = 280;
const THROW_MS_MAX = 720;

// Psi attack: a violet ripple cone projected from the caster onto the target.
const PSI_COLOR = 0xc86bff; // violet-magenta (psi/HQ/endgame per the Style Bible)
const PSI_MS = 620;
const PSI_RINGS = 3;

// Stun strike: a short amber-white electric arc burst at the struck unit.
const STUN_ARC_COLOR = 0xffe0a0; // amber-white (retunes the old electric-cyan)
const STUN_ARC_MS = 240;
const STUN_ARCS = 7;
const STUN_ARC_VERTS = 4; // 2 line segments (origin->mid->tip) per arc

// Enhanced muzzle flash: a forward cone burst + ballistic sparks.
const MUZZLE_CONE_H = 0.42;
const MUZZLE_SPARKS = 6;
const MUZZLE_SPARK_MS = 130;
const MUZZLE_SPARK_GRAVITY = 6.0;

// Plasma bolt presentation: pulsing blob + crackling electricity arcs.
const PLASMA_PULSE_FREQ = 0.03; // radians/ms of the scale pulse
const PLASMA_ARCS = 6;

// Blast debris: solid tumbling chunks (distinct from the additive embers) +
// a second crisper shockwave ring.
const BLAST_DEBRIS = 5;
const BLAST_DEBRIS_COLOR = 0x3a3530;
const BLAST_SHOCK2_COLOR = 0xfff0d0;

const UP = new Vector3(0, 1, 0);
const Y_AXIS = new Vector3(0, 1, 0);

interface KindConfig {
  /** Tracer / bolt body colour. */
  color: number;
  /** Muzzle + impact spark colour. */
  flashColor: number;
  radius: number; // tracer cylinder radius
  length: number; // tracer cylinder length (stretch)
  speedUPerS: number; // travel speed -> derives duration from distance
  minMs: number;
  maxMs: number;
  tracerOpacity: number;
  muzzleRadius: number;
  impactRadius: number;
  impactGrow: number; // how much the impact spark expands while fading
}

const CONFIG: Record<ProjectileKind, KindConfig> = {
  // Kinetic rounds are thin, fast streaks; plasma stays a slower, fatter bolt.
  rifle: {
    color: 0xfff070,
    flashColor: 0xfff7c0,
    radius: 0.022,
    length: 0.72,
    speedUPerS: 190,
    minMs: 80,
    maxMs: 140,
    tracerOpacity: 0.95,
    muzzleRadius: 0.15,
    impactRadius: 0.11,
    impactGrow: 1.8,
  },
  pistol: {
    color: 0xff9b54,
    flashColor: 0xffe0a8,
    radius: 0.017,
    length: 0.48,
    speedUPerS: 170,
    minMs: 72,
    maxMs: 130,
    tracerOpacity: 0.95,
    muzzleRadius: 0.11,
    impactRadius: 0.085,
    impactGrow: 1.6,
  },
  plasma: {
    color: 0xc44dff,
    flashColor: 0x77e6ff,
    radius: 0.1,
    length: 0.7,
    speedUPerS: 78,
    minMs: 130,
    maxMs: 220,
    tracerOpacity: 0.9,
    muzzleRadius: 0.24,
    impactRadius: 0.2,
    impactGrow: 2.6,
  },
};

// ---------------------------------------------------------------------------
// Pooled geometry: the spark/smoke fans upload byte-identical GPU buffers on
// every shot/blast. Sharing one geometry per shape (radius derives only from the
// kind's cfg, not per-round state; smoke is scaled per-mesh) uploads each buffer
// ONCE for the module's lifetime instead of dozens per trigger pull. These are
// never disposed with an individual mesh — {@link disposeMesh} skips any geometry
// in this set — so the churn becomes cheap material-only allocation.
// ---------------------------------------------------------------------------

const POOLED_GEOMETRIES = new Set<BufferGeometry>();

/** Muzzle-spark ember: the same tiny sphere for every weapon kind. */
const MUZZLE_SPARK_GEOMETRY = new SphereGeometry(0.03, 5, 4);
POOLED_GEOMETRIES.add(MUZZLE_SPARK_GEOMETRY);

/** Impact-spark ember: one sphere per kind (radius is a pure function of cfg). */
const IMPACT_SPARK_GEOMETRIES: Record<ProjectileKind, SphereGeometry> = {
  rifle: new SphereGeometry(Math.max(0.02, CONFIG.rifle.impactRadius * 0.28), 5, 4),
  pistol: new SphereGeometry(Math.max(0.02, CONFIG.pistol.impactRadius * 0.28), 5, 4),
  plasma: new SphereGeometry(Math.max(0.02, CONFIG.plasma.impactRadius * 0.28), 5, 4),
};
for (const g of Object.values(IMPACT_SPARK_GEOMETRIES)) POOLED_GEOMETRIES.add(g);

/** Blast smoke puff: one identical sphere per detonation, scaled per mesh. */
const BLAST_SMOKE_GEOMETRY = new SphereGeometry(0.4, 10, 8);
POOLED_GEOMETRIES.add(BLAST_SMOKE_GEOMETRY);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

/**
 * Push the colour into HDR (> 1 per channel) so the value survives into the
 * composer's float buffer above the bloom threshold — tracers, muzzle flashes
 * and impact sparks then glow. `toneMapped = false` keeps them punchy through
 * the ACES OutputPass. Additive blending + the animated `opacity` still drive
 * the fade in/out as before.
 */
const BLOOM_BOOST = 2.4;

function additiveMaterial(color: number, opacity: number): MeshBasicMaterial {
  const mat = new MeshBasicMaterial({
    color: new Color(color).multiplyScalar(BLOOM_BOOST),
    transparent: true,
    opacity,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  mat.toneMapped = false;
  return mat;
}

/**
 * Additive line material for the plasma bolt's electricity arcs. Same HDR boost
 * + tone-mapping bypass as {@link additiveMaterial} so the arcs survive into the
 * bloom buffer; `LineBasicMaterial` is the correct (wire-only) shading for lines.
 */
function additiveLineMaterial(color: number, opacity: number): LineBasicMaterial {
  const mat = new LineBasicMaterial({
    color: new Color(color).multiplyScalar(BLOOM_BOOST),
    transparent: true,
    opacity,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  mat.toneMapped = false;
  return mat;
}

function disposeMesh(parent: Object3D, m: Object3D): void {
  parent.remove(m);
  const geo = (m as { geometry?: BufferGeometry }).geometry;
  // Pooled geometries are shared across many meshes and live for the module's
  // lifetime — disposing one here would free a buffer other live meshes use.
  if (geo && !POOLED_GEOMETRIES.has(geo)) geo.dispose();
  const mat = (m as { material?: { dispose(): void } | { dispose(): void }[] }).material;
  if (mat) {
    if (Array.isArray(mat)) for (const x of mat) x.dispose();
    else mat.dispose();
  }
}

/** A single round's pre-built meshes plus its timeline update. */
interface RoundAnim {
  /** Advance to `elapsed` ms (from volley start). Returns true once fully done. */
  update(elapsed: number): boolean;
  meshes: Object3D[];
}

/** A volley in flight: lets {@link Effects.dispose} tear it down cleanly. */
interface VolleyHandle {
  raf: number;
  finish(): void; // idempotent: dispose meshes + resolve the promise
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

export class Effects {
  private readonly parent: Object3D;
  private readonly active = new Set<VolleyHandle>();

  constructor(parent: Object3D) {
    this.parent = parent;
  }

  /**
   * Draw and animate a whole volley, resolving once every round's visuals have
   * finished. All transient meshes are removed and disposed before resolving.
   */
  fireVolley(opts: FireVolleyOptions): Promise<void> {
    const cfg = CONFIG[opts.kind];
    const muzzle = opts.from.clone();
    const target = opts.to.clone();

    const anims: RoundAnim[] = [];
    const allMeshes: Object3D[] = [];
    for (let i = 0; i < opts.rounds.length; i++) {
      const round = opts.rounds[i];
      if (!round) continue;
      const anim = this.buildRound(cfg, opts.kind, muzzle, target, round, i * STAGGER_MS);
      anims.push(anim);
      for (const m of anim.meshes) {
        this.parent.add(m);
        allMeshes.push(m);
      }
    }

    return new Promise<void>((resolve) => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        for (const m of allMeshes) disposeMesh(this.parent, m);
        this.active.delete(handle);
        resolve();
      };
      const handle: VolleyHandle = { raf: 0, finish };
      this.active.add(handle);

      // Nothing to draw: resolve on the next frame to keep callers async-safe.
      if (anims.length === 0) {
        handle.raf = requestAnimationFrame(() => finish());
        return;
      }

      const start = performance.now();
      const tick = (now: number): void => {
        const elapsed = now - start;
        let allDone = true;
        for (const a of anims) {
          if (!a.update(elapsed)) allDone = false;
        }
        if (allDone) {
          finish();
          return;
        }
        handle.raf = requestAnimationFrame(tick);
      };
      handle.raf = requestAnimationFrame(tick);
    });
  }

  /**
   * Detonation FX for a grenade/HE blast: a bright emissive core that swells
   * and fades, an expanding ground shockwave ring scaled by the blast radius,
   * and a fan of ballistic sparks. Resolves once the effect has fully played
   * and every mesh has been disposed. All meshes are registered with the
   * active-handle set so {@link dispose} can tear a live blast down cleanly.
   */
  playBlast(center: Vector3, radius: number): Promise<void> {
    const cx = center.x;
    const cz = center.z;
    const groundY = Math.max(center.y, 0.15);

    // Bright core flash — pops up, swells, fades.
    const core = new Mesh(
      new SphereGeometry(0.32, 16, 12),
      additiveMaterial(BLAST_CORE_COLOR, 1),
    );
    core.position.set(cx, groundY + 0.25, cz);

    // Ground shockwave ring — expands outward to ~radius.
    const shock = new Mesh(
      new RingGeometry(0.7, 1.0, 48),
      additiveMaterial(BLAST_SHOCK_COLOR, 0.95),
    );
    shock.rotation.x = -Math.PI / 2;
    shock.position.set(cx, 0.05, cz);

    const meshes: Mesh[] = [core, shock];

    // Ballistic sparks radiating outward then falling + bouncing.
    const sparks: { mesh: Mesh; vx: number; vy: number; vz: number }[] = [];
    for (let i = 0; i < BLAST_SPARKS; i++) {
      const spark = new Mesh(
        new SphereGeometry(0.07, 6, 6),
        additiveMaterial(BLAST_SPARK_COLOR, 1),
      );
      spark.position.set(cx, groundY, cz);
      const angle = (i / BLAST_SPARKS) * Math.PI * 2;
      const speed = (0.9 + ((i * 13) % 7) / 7) * Math.max(radius, 1);
      sparks.push({
        mesh: spark,
        vx: Math.cos(angle) * speed,
        vy: 2.4 + ((i * 5) % 5) * 0.4,
        vz: Math.sin(angle) * speed,
      });
      meshes.push(spark);
    }

    // Secondary shockwave — thinner, hotter, expands faster than the main ring.
    const shock2 = new Mesh(
      new RingGeometry(0.86, 1.0, 48),
      additiveMaterial(BLAST_SHOCK2_COLOR, 0.9),
    );
    shock2.rotation.x = -Math.PI / 2;
    shock2.position.set(cx, 0.07, cz);
    meshes.push(shock2);

    // Solid tumbling debris chunks — distinct from the additive embers: lit
    // rubble that arcs out, bounces, and spins before the effect disposes.
    const debris: {
      mesh: Mesh;
      vx: number;
      vy: number;
      vz: number;
      rx: number;
      rz: number;
    }[] = [];
    for (let i = 0; i < BLAST_DEBRIS; i++) {
      const chunk = new Mesh(
        new BoxGeometry(0.13, 0.13, 0.13),
        new MeshStandardMaterial({ color: BLAST_DEBRIS_COLOR, roughness: 1 }),
      );
      chunk.position.set(cx, groundY, cz);
      const angle = (i / BLAST_DEBRIS) * Math.PI * 2 + 0.35;
      const speed = (1.1 + ((i * 11) % 5) / 5) * Math.max(radius, 1);
      debris.push({
        mesh: chunk,
        vx: Math.cos(angle) * speed,
        vy: 2.0 + ((i * 7) % 4) * 0.5,
        vz: Math.sin(angle) * speed,
        rx: 4 + (i % 3),
        rz: 3 + (i % 2) * 1.5,
      });
      meshes.push(chunk);
    }

    // Slow smoke: cool-dark puffs that rise, swell and fade well after the
    // flash. Normal (not additive) blending so they read DARK against the field
    // — the lingering aftermath of the blast. Deterministic offsets per index.
    const smoke: { mesh: Mesh; vy: number; ox: number; oz: number; grow: number }[] = [];
    for (let i = 0; i < BLAST_SMOKE; i++) {
      // Shared geometry (pooled); only the material is per-puff because its
      // opacity is animated independently as the puff fades.
      const puff = new Mesh(
        BLAST_SMOKE_GEOMETRY,
        new MeshBasicMaterial({
          color: BLAST_SMOKE_COLOR,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        }),
      );
      const angle = (i / BLAST_SMOKE) * Math.PI * 2 + 0.9;
      const spread = 0.25 + ((i * 7) % 3) * 0.18;
      puff.position.set(cx + Math.cos(angle) * spread, groundY + 0.2, cz + Math.sin(angle) * spread);
      smoke.push({
        mesh: puff,
        vy: 0.55 + ((i * 5) % 4) * 0.12,
        ox: Math.cos(angle) * 0.35,
        oz: Math.sin(angle) * 0.35,
        grow: 1.6 + ((i * 11) % 5) * 0.25,
      });
      meshes.push(puff);
    }

    for (const m of meshes) this.parent.add(m);
    const coreMat = core.material as MeshBasicMaterial;
    const shockMat = shock.material as MeshBasicMaterial;
    const shock2Mat = shock2.material as MeshBasicMaterial;
    const sparkMats = sparks.map((s) => s.mesh.material as MeshBasicMaterial);
    const smokeMats = smoke.map((s) => s.mesh.material as MeshBasicMaterial);

    const maxR = Math.max(radius, 0.5);

    return new Promise<void>((resolve) => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        for (const m of meshes) disposeMesh(this.parent, m);
        this.active.delete(handle);
        resolve();
      };
      const handle: VolleyHandle = { raf: 0, finish };
      this.active.add(handle);

      const start = performance.now();
      let last = start;
      const tick = (now: number): void => {
        const elapsed = now - start;
        if (elapsed >= BLAST_MS) {
          finish();
          return;
        }
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        const t = elapsed / BLAST_MS;

        // Core: fast swell, quick fade.
        core.scale.setScalar(0.6 + t * maxR * 1.8);
        coreMat.opacity = clamp01(1 - t * 1.25);

        // Shockwave: ring expands along the ground, fading.
        const sr = 0.4 + t * maxR * 1.3;
        shock.scale.set(sr, sr, sr);
        shockMat.opacity = clamp01(0.95 * (1 - t * 1.1));

        // Sparks: ballistic with gravity + ground bounce + friction.
        for (let i = 0; i < sparks.length; i++) {
          const s = sparks[i]!;
          s.mesh.position.x += s.vx * dt;
          s.mesh.position.z += s.vz * dt;
          s.vy -= 9.5 * dt;
          s.mesh.position.y += s.vy * dt;
          if (s.mesh.position.y < 0.06) {
            s.mesh.position.y = 0.06;
            s.vy *= -0.35;
            s.vx *= 0.55;
            s.vz *= 0.55;
          }
          sparkMats[i]!.opacity = clamp01(1 - t * 1.5);
        }

        // Secondary shockwave: faster + hotter, fades quicker than the main ring.
        const s2r = 0.3 + t * maxR * 1.9;
        shock2.scale.set(s2r, s2r, s2r);
        shock2Mat.opacity = clamp01(0.9 * Math.max(0, 1 - t * 1.6));

        // Debris: ballistic + tumble + ground bounce.
        for (let i = 0; i < debris.length; i++) {
          const d = debris[i]!;
          d.mesh.position.x += d.vx * dt;
          d.mesh.position.z += d.vz * dt;
          d.vy -= 9.5 * dt;
          d.mesh.position.y += d.vy * dt;
          if (d.mesh.position.y < 0.08) {
            d.mesh.position.y = 0.08;
            d.vy *= -0.3;
            d.vx *= 0.5;
            d.vz *= 0.5;
          }
          d.mesh.rotation.x += d.rx * dt;
          d.mesh.rotation.z += d.rz * dt;
        }

        // Smoke: rises + swells; opacity ramps in fast then eases out to nil.
        for (let i = 0; i < smoke.length; i++) {
          const s = smoke[i]!;
          s.mesh.position.x += s.ox * dt;
          s.mesh.position.z += s.oz * dt;
          s.mesh.position.y += s.vy * dt;
          s.mesh.scale.setScalar(0.6 + t * s.grow * maxR * 0.5);
          const rampIn = clamp01(t / 0.25);
          smokeMats[i]!.opacity = 0.42 * rampIn * (1 - t);
        }

        handle.raf = requestAnimationFrame(tick);
      };
      handle.raf = requestAnimationFrame(tick);
    });
  }

  /**
   * A short emissive arc from `from` to `to` — the travel cue for a thrown
   * item (grenade, …). A glowing projectile follows a parabola and a faint
   * target ring marks the landing tile. Resolves when the projectile lands.
   */
  playThrowArc(from: Vector3, to: Vector3): Promise<void> {
    const dist = from.distanceTo(to);

    const projectile = new Mesh(
      new SphereGeometry(0.14, 10, 8),
      additiveMaterial(THROW_COLOR, 1),
    );
    projectile.position.copy(from);

    const target = new Mesh(
      new RingGeometry(0.28, 0.36, 32),
      additiveMaterial(THROW_COLOR, 0.7),
    );
    target.rotation.x = -Math.PI / 2;
    target.position.set(to.x, 0.06, to.z);

    const meshes: Mesh[] = [projectile, target];
    for (const m of meshes) this.parent.add(m);
    const targetMat = target.material as MeshBasicMaterial;

    const duration = clamp(dist * 65, THROW_MS_MIN, THROW_MS_MAX);
    const peak = 0.9 + dist * 0.18;
    const scratch = new Vector3();

    return new Promise<void>((resolve) => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        for (const m of meshes) disposeMesh(this.parent, m);
        this.active.delete(handle);
        resolve();
      };
      const handle: VolleyHandle = { raf: 0, finish };
      this.active.add(handle);

      const start = performance.now();
      const tick = (now: number): void => {
        const elapsed = now - start;
        const t = elapsed / duration;
        if (t >= 1) {
          finish();
          return;
        }
        const arc = Math.sin(t * Math.PI); // 0..1..0 parabola
        scratch.lerpVectors(from, to, t);
        scratch.y += arc * peak;
        projectile.position.copy(scratch);
        // Target ring pulses subtly as the projectile approaches.
        target.scale.setScalar(1 + Math.sin(elapsed * 0.02) * 0.08);
        targetMat.opacity = 0.55 + arc * 0.25;
        handle.raf = requestAnimationFrame(tick);
      };
      handle.raf = requestAnimationFrame(tick);
    });
  }

  /**
   * Psi-attack FX: a violet ripple cone projected from the caster (`from`) onto
   * the target (`to`) — a soft cone that fades in/out plus staggered rings that
   * travel the length of it and expand as they arrive. Resolves once the effect
   * has fully played and every mesh has been disposed. Registered with the
   * active-handle set so {@link dispose} can tear a live cast down cleanly.
   *
   * NOT yet wired: the renderer/controller must call this on a successful
   * `psiUsed` event (see the integration note returned with this change).
   */
  playPsi(from: Vector3, to: Vector3): Promise<void> {
    const dir = to.clone().sub(from);
    const dist = Math.max(dir.length(), EPS);
    dir.normalize();

    // Cone: apex at the caster, widening toward the target. A cone's local +Y
    // is its apex, so mapping +Y -> -dir puts the apex at `from`.
    const cone = new Mesh(
      new ConeGeometry(Math.min(0.9, dist * 0.32), dist, 20, 1, true),
      additiveMaterial(PSI_COLOR, 0.28),
    );
    cone.quaternion.setFromUnitVectors(UP, dir.clone().negate());
    cone.position.copy(from).addScaledVector(dir, dist * 0.5);

    // Ripple rings: face down the axis (+Z -> dir) and slide caster -> target.
    const ringOrient = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), dir);
    const rings: Mesh[] = [];
    for (let i = 0; i < PSI_RINGS; i++) {
      const ring = new Mesh(new RingGeometry(0.18, 0.3, 28), additiveMaterial(PSI_COLOR, 0.9));
      ring.quaternion.copy(ringOrient);
      rings.push(ring);
    }

    const meshes: Mesh[] = [cone, ...rings];
    for (const m of meshes) this.parent.add(m);
    const coneMat = cone.material as MeshBasicMaterial;
    const ringMats = rings.map((r) => r.material as MeshBasicMaterial);
    const scratch = new Vector3();

    return new Promise<void>((resolve) => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        for (const m of meshes) disposeMesh(this.parent, m);
        this.active.delete(handle);
        resolve();
      };
      const handle: VolleyHandle = { raf: 0, finish };
      this.active.add(handle);

      const start = performance.now();
      const tick = (now: number): void => {
        const t = (now - start) / PSI_MS;
        if (t >= 1) {
          finish();
          return;
        }
        // Cone: subtle width pulse + a soft fade in then out (sin over the life).
        const pulse = 1 + Math.sin(t * Math.PI * 4) * 0.06;
        cone.scale.set(pulse, 1, pulse);
        coneMat.opacity = 0.28 * Math.sin(t * Math.PI);
        for (let i = 0; i < rings.length; i++) {
          const rp = (t + i / rings.length) % 1; // staggered travel 0..1
          scratch.copy(from).addScaledVector(dir, rp * dist);
          rings[i]!.position.copy(scratch);
          rings[i]!.scale.setScalar(0.4 + rp * 1.8);
          ringMats[i]!.opacity = 0.9 * (1 - rp);
        }
        handle.raf = requestAnimationFrame(tick);
      };
      handle.raf = requestAnimationFrame(tick);
    });
  }

  /**
   * Stun-strike FX: a short amber-white electric arc burst at world point `at`
   * — jagged line arcs that crackle outward and flicker out. This is the
   * mesh-level arc the Style Bible calls for; it retunes the old electric-cyan
   * cue to amber-white. Resolves once fully played and disposed.
   *
   * NOT yet wired: the renderer's `playStunStrike` should call this (and recolor
   * its emissive flush + floating number to match) — see the integration note.
   */
  playStunArc(at: Vector3): Promise<void> {
    const geo = new BufferGeometry();
    geo.setAttribute(
      "position",
      new Float32BufferAttribute(new Array(STUN_ARCS * STUN_ARC_VERTS * 3).fill(0), 3),
    );
    const pos = geo.getAttribute("position") as Float32BufferAttribute;
    const arcs = new LineSegments(geo, additiveLineMaterial(STUN_ARC_COLOR, 1));
    arcs.position.copy(at);

    // Deterministic outward directions: a fan around the unit, biased upward.
    const dirs: Vector3[] = [];
    for (let i = 0; i < STUN_ARCS; i++) {
      const az = (i / STUN_ARCS) * Math.PI * 2;
      const el = 0.4 + (((i * 7) % 5) / 5) * 0.7;
      dirs.push(
        new Vector3(
          Math.cos(az) * Math.cos(el),
          Math.sin(el),
          Math.sin(az) * Math.cos(el),
        ).normalize(),
      );
    }

    this.parent.add(arcs);
    const arcsMat = arcs.material as LineBasicMaterial;
    const arr = pos.array as Float32Array;

    return new Promise<void>((resolve) => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        disposeMesh(this.parent, arcs);
        this.active.delete(handle);
        resolve();
      };
      const handle: VolleyHandle = { raf: 0, finish };
      this.active.add(handle);

      const start = performance.now();
      const tick = (now: number): void => {
        const el = now - start;
        const t = el / STUN_ARC_MS;
        if (t >= 1) {
          finish();
          return;
        }
        // Jitter each arc's mid + tip so it crackles; flicker the opacity out.
        for (let i = 0; i < STUN_ARCS; i++) {
          const d = dirs[i]!;
          const len = 0.5 + ((i * 11) % 4) * 0.12;
          const midR = len * 0.5;
          const jx = Math.sin(el * 0.09 + i) * 0.12;
          const jy = Math.cos(el * 0.08 + i * 1.7) * 0.12;
          const jz = Math.sin(el * 0.1 + i * 2.3) * 0.12;
          const base = i * STUN_ARC_VERTS * 3;
          // seg 1: origin -> jittered mid.
          arr[base] = 0;
          arr[base + 1] = 0.1;
          arr[base + 2] = 0;
          arr[base + 3] = d.x * midR + jx;
          arr[base + 4] = d.y * midR + 0.1 + jy;
          arr[base + 5] = d.z * midR + jz;
          // seg 2: jittered mid -> tip.
          arr[base + 6] = d.x * midR + jx;
          arr[base + 7] = d.y * midR + 0.1 + jy;
          arr[base + 8] = d.z * midR + jz;
          arr[base + 9] = d.x * len;
          arr[base + 10] = d.y * len + 0.1;
          arr[base + 11] = d.z * len;
        }
        pos.needsUpdate = true;
        arcsMat.opacity = (1 - t) * (0.6 + 0.4 * Math.abs(Math.sin(el * 0.12)));
        handle.raf = requestAnimationFrame(tick);
      };
      handle.raf = requestAnimationFrame(tick);
    });
  }

  /** Cancel every in-flight volley and dispose its meshes. No persistent state. */
  dispose(): void {
    for (const handle of [...this.active]) {
      cancelAnimationFrame(handle.raf);
      handle.finish();
    }
    this.active.clear();
  }

  // -------------------------------------------------------------------------

  private buildRound(
    cfg: KindConfig,
    kind: ProjectileKind,
    muzzle: Vector3,
    target: Vector3,
    round: VolleyRound,
    startMs: number,
  ): RoundAnim {
    // True bearing muzzle->target, then deviate about world Y for this round.
    const bearing = target.clone().sub(muzzle);
    const trueDist = bearing.length();
    const dir =
      trueDist < EPS
        ? new Vector3(1, 0, 0)
        : bearing.clone().applyAxisAngle(Y_AXIS, round.deviationRad).normalize();

    // Hits terminate at the target distance; misses sail downrange (capped).
    const travelDist = round.hit
      ? Math.max(trueDist, EPS)
      : clamp(trueDist + MISS_EXTRA, 1, MAX_TRAVEL);
    const endPoint = muzzle.clone().addScaledVector(dir, travelDist);
    const travelMs = clamp((travelDist / cfg.speedUPerS) * 1000, cfg.minMs, cfg.maxMs);
    const isPlasma = cfg === CONFIG.plasma;

    // Orientation mapping + a stable perpendicular basis (cone / sparks /
    // electricity spread). Allocated once per round, never per frame.
    const orient = new Quaternion().setFromUnitVectors(UP, dir);
    const right = new Vector3().crossVectors(dir, UP);
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize();
    const up = new Vector3().crossVectors(right, dir).normalize();

    // --- Projectile body ---
    // Plasma: a pulsing blob. Kinetics: a stretched cylinder tail.
    const tracer = isPlasma
      ? new Mesh(
          new SphereGeometry(cfg.radius * 2.1, 12, 10),
          additiveMaterial(cfg.color, cfg.tracerOpacity),
        )
      : new Mesh(
          new CylinderGeometry(cfg.radius, cfg.radius, cfg.length, 8),
          additiveMaterial(cfg.color, cfg.tracerOpacity),
        );
    if (!isPlasma) tracer.quaternion.copy(orient);
    tracer.visible = false;

    // Kinetic only: bright leading head glow that rides the bolt's tip.
    const head: Mesh | null = isPlasma
      ? null
      : new Mesh(new SphereGeometry(cfg.radius * 1.7, 8, 8), additiveMaterial(cfg.flashColor, 1));
    if (head) head.visible = false;

    // Plasma only: crackling radial electricity arcs around the blob.
    let arcs: LineSegments | null = null;
    let arcsPos: Float32BufferAttribute | null = null;
    const arcDirs: Vector3[] = [];
    if (isPlasma) {
      const arcGeo = new BufferGeometry();
      arcGeo.setAttribute("position", new Float32BufferAttribute(new Array(PLASMA_ARCS * 6).fill(0), 3));
      arcsPos = arcGeo.getAttribute("position") as Float32BufferAttribute;
      arcs = new LineSegments(arcGeo, additiveLineMaterial(cfg.flashColor, 0.95));
      arcs.visible = false;
      // Even 3D spread (Fibonacci sphere) so the arcs point all around the blob.
      for (let i = 0; i < PLASMA_ARCS; i++) {
        const gi = (i + 0.5) / PLASMA_ARCS;
        const incl = Math.acos(1 - 2 * gi);
        const azim = Math.PI * (1 + Math.sqrt(5)) * i;
        arcDirs.push(
          new Vector3(
            Math.sin(incl) * Math.cos(azim),
            Math.cos(incl),
            Math.sin(incl) * Math.sin(azim),
          ),
        );
      }
    }

    // --- Muzzle flash: core sphere + forward cone + ballistic sparks ---
    const muzzleFlash = new Mesh(
      new SphereGeometry(cfg.muzzleRadius, 8, 8),
      additiveMaterial(cfg.flashColor, 1),
    );
    muzzleFlash.position.copy(muzzle);
    muzzleFlash.visible = false;

    const cone = new Mesh(
      new ConeGeometry(cfg.muzzleRadius * 1.5, MUZZLE_CONE_H, 10, 1, true),
      additiveMaterial(cfg.flashColor, 0.9),
    );
    cone.quaternion.copy(orient);
    cone.position.copy(muzzle).addScaledVector(dir, MUZZLE_CONE_H * 0.5);
    cone.visible = false;

    // All muzzle sparks of this round share one pooled geometry + one material
    // (identical colour, and they fade on the same timeline), so the fan is a
    // single material alloc instead of six, with zero geometry upload.
    const muzzleSparkMat = additiveMaterial(cfg.flashColor, 1);
    const sparks: { mesh: Mesh; vx: number; vy: number; vz: number }[] = [];
    for (let i = 0; i < MUZZLE_SPARKS; i++) {
      const spark = new Mesh(MUZZLE_SPARK_GEOMETRY, muzzleSparkMat);
      spark.position.copy(muzzle);
      const spreadA = (((i * 37) % 9) / 9 - 0.5) * 2; // deterministic -1..1
      const spreadB = (((i * 53) % 7) / 7 - 0.5) * 2;
      const vf = 2.6 + ((i * 17) % 5) * 0.4; // forward-biased speed
      const v = new Vector3()
        .addScaledVector(dir, vf)
        .addScaledVector(right, spreadA * 1.4)
        .addScaledVector(up, spreadB * 1.4);
      sparks.push({ mesh: spark, vx: v.x, vy: v.y, vz: v.z });
      spark.visible = false;
    }

    // --- Impact spark where this round ends ---
    const impact = new Mesh(
      new SphereGeometry(cfg.impactRadius, 8, 8),
      additiveMaterial(round.hit ? cfg.flashColor : cfg.color, 1),
    );
    impact.position.copy(endPoint);
    impact.visible = false;

    // Impact embers: a small fan thrown BACK off the struck surface. Velocities
    // are built from the shot's own basis (−dir back-splash + right/up spread)
    // with a deterministic per-index jitter, so no randomness enters the frame.
    // Same pooling as the muzzle fan: one pooled per-kind geometry + one shared
    // material (all embers of a round are the same colour and fade together).
    const impactSparkMat = additiveMaterial(round.hit ? cfg.flashColor : cfg.color, 1);
    const impactSparkGeo = IMPACT_SPARK_GEOMETRIES[kind];
    const impactSparks: { mesh: Mesh; vx: number; vy: number; vz: number }[] = [];
    for (let i = 0; i < IMPACT_SPARKS; i++) {
      const spark = new Mesh(impactSparkGeo, impactSparkMat);
      spark.position.copy(endPoint);
      const sA = (((i * 29) % 11) / 11 - 0.5) * 2; // deterministic -1..1
      const sB = (((i * 47) % 9) / 9 - 0.5) * 2;
      const back = 1.4 + ((i * 13) % 4) * 0.35; // back-splash off the surface
      const v = new Vector3()
        .addScaledVector(dir, -back)
        .addScaledVector(right, sA * 2.0)
        .addScaledVector(up, sB * 2.0 + 1.2);
      impactSparks.push({ mesh: spark, vx: v.x, vy: v.y, vz: v.z });
      spark.visible = false;
    }

    const flashMat = muzzleFlash.material as MeshBasicMaterial;
    const coneMat = cone.material as MeshBasicMaterial;
    const tracerMat = tracer.material as MeshBasicMaterial;
    const headMat = head ? (head.material as MeshBasicMaterial) : null;
    const arcsMat = arcs ? (arcs.material as LineBasicMaterial) : null;
    const impactMat = impact.material as MeshBasicMaterial;
    const sparkMats = sparks.map((s) => s.mesh.material as MeshBasicMaterial);
    const impactSparkMats = impactSparks.map((s) => s.mesh.material as MeshBasicMaterial);
    const scratch = new Vector3();
    let prevLocal = 0;

    const hideAll = (): void => {
      tracer.visible = false;
      if (head) head.visible = false;
      if (arcs) arcs.visible = false;
      muzzleFlash.visible = false;
      cone.visible = false;
      for (const s of sparks) s.mesh.visible = false;
      for (const s of impactSparks) s.mesh.visible = false;
      impact.visible = false;
    };

    const update = (elapsed: number): boolean => {
      const local = elapsed - startMs;
      if (local < 0) {
        hideAll();
        prevLocal = 0;
        return false;
      }
      const dt = Math.min(0.05, Math.max(0, local - prevLocal) / 1000);
      prevLocal = local;

      // MUZZLE: a hard 2-frame pop. Frame 0 = big hot flash + wide cone; frame
      // 1 = a smaller, dimmer after-flash; then it's gone. No easing between —
      // the discrete step is what sells the "flash".
      if (local <= MUZZLE_FLASH_MS) {
        const frame0 = local < MUZZLE_FRAME_MS;
        muzzleFlash.visible = true;
        cone.visible = true;
        flashMat.opacity = frame0 ? 1 : 0.5;
        muzzleFlash.scale.setScalar(frame0 ? 1.35 : 0.85);
        coneMat.opacity = frame0 ? 0.9 : 0.4;
        cone.scale.setScalar(frame0 ? 1.2 : 0.7);
      } else {
        muzzleFlash.visible = false;
        cone.visible = false;
      }

      // Sparks: flung forward from the muzzle, fade + fall during/after the flash.
      if (local <= MUZZLE_SPARK_MS) {
        const sf = clamp01(local / MUZZLE_SPARK_MS);
        for (let i = 0; i < sparks.length; i++) {
          const s = sparks[i]!;
          s.mesh.visible = true;
          s.mesh.position.x += s.vx * dt;
          s.mesh.position.y += s.vy * dt;
          s.mesh.position.z += s.vz * dt;
          s.vy -= MUZZLE_SPARK_GRAVITY * dt;
          sparkMats[i]!.opacity = 1 - sf;
        }
      } else {
        for (const s of sparks) s.mesh.visible = false;
      }

      // TRAVEL: bolt muzzle -> endpoint, leading tip arrives at p = 1.
      if (local < travelMs) {
        const p = clamp01(local / travelMs);
        if (isPlasma) {
          // Blob center rides the bearing; pulses in scale.
          scratch.copy(muzzle).addScaledVector(dir, p * travelDist);
          tracer.position.copy(scratch);
          tracer.scale.setScalar(1 + Math.sin(local * PLASMA_PULSE_FREQ) * 0.18);
          tracer.visible = true;
          // Electricity: jitter the outer endpoint of each arc around the blob.
          if (arcs && arcsPos && arcsMat) {
            arcs.position.copy(scratch);
            arcs.visible = true;
            const arr = arcsPos.array as Float32Array;
            const rIn = cfg.radius * 1.4;
            for (let i = 0; i < PLASMA_ARCS; i++) {
              const d = arcDirs[i]!;
              const ix = i * 6;
              const rOut =
                cfg.radius * (2.3 + ((i * 41) % 5) * 0.16) +
                Math.sin(local * 0.05 + i) * 0.12;
              arr[ix] = d.x * rIn;
              arr[ix + 1] = d.y * rIn;
              arr[ix + 2] = d.z * rIn;
              arr[ix + 3] = d.x * rOut + Math.sin(local * 0.07 + i * 1.7) * 0.05;
              arr[ix + 4] = d.y * rOut + Math.cos(local * 0.065 + i * 2.3) * 0.05;
              arr[ix + 5] = d.z * rOut + Math.sin(local * 0.08 + i * 3.1) * 0.05;
            }
            arcsPos.needsUpdate = true;
            arcsMat.opacity = 0.95 * (1 - p * 0.3);
          }
        } else {
          // Tail cylinder (fades as it travels) + bright head glow at the tip.
          scratch.copy(muzzle).addScaledVector(dir, p * travelDist - cfg.length * 0.5);
          tracer.position.copy(scratch);
          tracer.visible = true;
          tracerMat.opacity = cfg.tracerOpacity * (1 - p * 0.55);
          if (head && headMat) {
            scratch.copy(muzzle).addScaledVector(dir, p * travelDist);
            head.position.copy(scratch);
            head.visible = true;
            headMat.opacity = 1 - p * 0.2;
          }
        }
        impact.visible = false;
        return false;
      }
      tracer.visible = false;
      if (head) head.visible = false;
      if (arcs) arcs.visible = false;

      // IMPACT: the core spark expands + fades while a fan of embers is thrown
      // back off the surface (ballistic + gravity, integrated analytically from
      // iLocal so nothing accumulates). The round finishes once both are done.
      const iLocal = local - travelMs;
      const flashDone = iLocal > IMPACT_FLASH_MS;
      if (!flashDone) {
        const f = clamp01(iLocal / IMPACT_FLASH_MS);
        impact.visible = true;
        impactMat.opacity = 1 - f;
        impact.scale.setScalar(0.5 + f * cfg.impactGrow);
      } else {
        impact.visible = false;
      }

      const sparksDone = iLocal > IMPACT_SPARK_MS;
      if (!sparksDone) {
        const sf = clamp01(iLocal / IMPACT_SPARK_MS);
        const tS = iLocal / 1000;
        for (let i = 0; i < impactSparks.length; i++) {
          const s = impactSparks[i]!;
          scratch.copy(endPoint);
          scratch.x += s.vx * tS;
          scratch.z += s.vz * tS;
          scratch.y += s.vy * tS - 0.5 * IMPACT_SPARK_GRAVITY * tS * tS;
          if (scratch.y < 0.05) scratch.y = 0.05;
          s.mesh.position.copy(scratch);
          s.mesh.visible = true;
          impactSparkMats[i]!.opacity = 1 - sf;
        }
      } else {
        for (const s of impactSparks) s.mesh.visible = false;
      }

      if (flashDone && sparksDone) return true;
      return false;
    };

    const meshes: Object3D[] = [tracer, muzzleFlash, cone, impact];
    if (head) meshes.push(head);
    if (arcs) meshes.push(arcs);
    for (const s of sparks) meshes.push(s.mesh);
    for (const s of impactSparks) meshes.push(s.mesh);
    return { update, meshes };
  }
}

/** Tear down an {@link Effects} instance (cancels in-flight volleys). */
export function disposeEffects(effects: Effects): void {
  effects.dispose();
}

export default Effects;
