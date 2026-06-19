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
  Color,
  CylinderGeometry,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
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
const MUZZLE_FLASH_MS = 70;
const IMPACT_FLASH_MS = 140;
const MISS_EXTRA = 4.5; // tiles a miss continues past the target
const MAX_TRAVEL = 28; // hard cap so strays never shoot to infinity
const EPS = 1e-6;

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
  rifle: {
    color: 0xfff070,
    flashColor: 0xfff7c0,
    radius: 0.035,
    length: 0.9,
    speedUPerS: 120,
    minMs: 120,
    maxMs: 200,
    tracerOpacity: 0.95,
    muzzleRadius: 0.16,
    impactRadius: 0.12,
    impactGrow: 1.8,
  },
  pistol: {
    color: 0xff9b54,
    flashColor: 0xffe0a8,
    radius: 0.026,
    length: 0.55,
    speedUPerS: 105,
    minMs: 110,
    maxMs: 190,
    tracerOpacity: 0.95,
    muzzleRadius: 0.12,
    impactRadius: 0.09,
    impactGrow: 1.6,
  },
  plasma: {
    color: 0xc44dff,
    flashColor: 0x77e6ff,
    radius: 0.1,
    length: 0.7,
    speedUPerS: 55,
    minMs: 160,
    maxMs: 280,
    tracerOpacity: 0.9,
    muzzleRadius: 0.24,
    impactRadius: 0.2,
    impactGrow: 2.6,
  },
};

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

function disposeMesh(parent: Object3D, m: Mesh): void {
  parent.remove(m);
  m.geometry.dispose();
  const mat = m.material;
  if (Array.isArray(mat)) for (const x of mat) x.dispose();
  else mat.dispose();
}

/** A single round's pre-built meshes plus its timeline update. */
interface RoundAnim {
  /** Advance to `elapsed` ms (from volley start). Returns true once fully done. */
  update(elapsed: number): boolean;
  meshes: Mesh[];
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
    const allMeshes: Mesh[] = [];
    for (let i = 0; i < opts.rounds.length; i++) {
      const round = opts.rounds[i];
      if (!round) continue;
      const anim = this.buildRound(cfg, muzzle, target, round, i * STAGGER_MS);
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

    // Tracer / bolt: a stretched cylinder oriented along the shot direction.
    const tracer = new Mesh(
      new CylinderGeometry(cfg.radius, cfg.radius, cfg.length, 8),
      additiveMaterial(cfg.color, cfg.tracerOpacity),
    );
    tracer.quaternion.copy(new Quaternion().setFromUnitVectors(UP, dir));
    tracer.visible = false;

    // Muzzle flash at the origin.
    const muzzleFlash = new Mesh(
      new SphereGeometry(cfg.muzzleRadius, 8, 8),
      additiveMaterial(cfg.flashColor, 1),
    );
    muzzleFlash.position.copy(muzzle);
    muzzleFlash.visible = false;

    // Impact spark where this round ends.
    const impact = new Mesh(
      new SphereGeometry(cfg.impactRadius, 8, 8),
      additiveMaterial(round.hit ? cfg.flashColor : cfg.color, 1),
    );
    impact.position.copy(endPoint);
    impact.visible = false;

    const flashMat = muzzleFlash.material as MeshBasicMaterial;
    const impactMat = impact.material as MeshBasicMaterial;
    const scratch = new Vector3();

    const update = (elapsed: number): boolean => {
      const local = elapsed - startMs;
      if (local < 0) {
        tracer.visible = false;
        muzzleFlash.visible = false;
        impact.visible = false;
        return false;
      }

      // Muzzle flash: bright pop that fades + swells briefly.
      if (local <= MUZZLE_FLASH_MS) {
        const f = clamp01(local / MUZZLE_FLASH_MS);
        muzzleFlash.visible = true;
        flashMat.opacity = 1 - f;
        muzzleFlash.scale.setScalar(0.6 + f * 0.9);
      } else {
        muzzleFlash.visible = false;
      }

      // Tracer travels muzzle -> endpoint; leading tip reaches endPoint at p=1.
      if (local < travelMs) {
        const p = clamp01(local / travelMs);
        scratch
          .copy(muzzle)
          .addScaledVector(dir, p * travelDist - cfg.length * 0.5);
        tracer.position.copy(scratch);
        tracer.visible = true;
        impact.visible = false;
        return false;
      }
      tracer.visible = false;

      // Impact spark: expands and fades.
      const iLocal = local - travelMs;
      if (iLocal <= IMPACT_FLASH_MS) {
        const f = clamp01(iLocal / IMPACT_FLASH_MS);
        impact.visible = true;
        impactMat.opacity = 1 - f;
        impact.scale.setScalar(0.5 + f * cfg.impactGrow);
        return false;
      }

      impact.visible = false;
      return true;
    };

    return { update, meshes: [tracer, muzzleFlash, impact] };
  }
}

/** Tear down an {@link Effects} instance (cancels in-flight volleys). */
export function disposeEffects(effects: Effects): void {
  effects.dispose();
}

export default Effects;
