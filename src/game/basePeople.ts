/**
 * Animated crew system for the base "cutaway" diorama (Layer 2). Low-poly
 * humanoid personnel that walk the corridor waypoint loop (or idle in place)
 * so the base reads as a living, populated facility — sculpted figures with a
 * real walk cycle, not capsule blobs.
 *
 * Figure (origin at the feet, ~0.34 tall): a beveled helmet head with a
 * glowing visor, an extruded TAPERED torso (chamfered via ExtrudeGeometry
 * bevel), a diagonal accent sash + high-vis chest beacon, and articulated
 * limbs — two arms (upper + fore) and two legs (thigh + shin) hung from joint
 * pivots so a walk cycle can swing them.
 *
 * Walk cycle (in tick, allocation-free): legs alternate swing at the hip with
 * a phase-coupled knee bend (lift), arms counter-swing with a bent elbow, the
 * trunk carries a subtle forward lean + lateral weight shift, and the whole
 * figure bobs vertically twice per stride (one rise per planted step). Leg
 * phase is derived from DISTANCE travelled (not wall-clock) so feet stay
 * planted and never slide. Idle figures hold a relaxed stance with a gentle
 * sway + breathing bob.
 *
 * Art vocabulary: coveralls are a procedural woven canvas texture (people-
 * domain cloth; baseTextures covers architecture) tinted from the frozen
 * palette; the helmet reuses baseTextures.wornSteelMaterial (shared metal
 * vocabulary) and the sash/beacon/visor are baseTextures.accentEmissive in
 * palette accent colors. No ad-hoc hex anywhere.
 *
 * Determinism: all placement / speed / phase decisions flow from a seeded LCG
 * (Numerical-Recipes constants) built from `opts.seed` — NEVER Math.random, so
 * the same base always populates identically.
 *
 * Performance: count is capped (<=14); geometries + the coveralls material are
 * created once per instance and shared across every figure; `tick` performs
 * ZERO allocation — it only mutates pre-built joint rotations/positions in
 * place (lerpVectors is allocation-free; all joint math is scalar). dispose()
 * detaches the group and frees the instance-owned geometry + coveralls
 * material/texture resources. Materials returned by baseTextures are
 * intentionally NOT disposed here — they are module-cached shared vocabulary
 * (disposing them would break sibling consumers); they persist for the page.
 */
import {
  BoxGeometry,
  CanvasTexture,
  CylinderGeometry,
  Color,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Shape,
  SphereGeometry,
  Vector3,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { accentEmissive, wornSteelMaterial } from "./baseTextures";
import { BASE_PALETTE } from "./basePalette";

/** Options for constructing a {@link CrewSystem}. */
export interface CrewOptions {
  /** Closed loop of corridor waypoints the crew walks, in world space. */
  readonly waypoints: Vector3[];
  /** Desired crew count (clamped to [0, MAX_CREW]). A couple will idle. */
  readonly count: number;
  /** Seed for the deterministic LCG that places/speeds/phases the crew. */
  readonly seed: number;
}

/** Maximum number of crew figures (pool cap). */
const MAX_CREW = 14;

// --- Figure proportions (total height ~0.34; feet at y=0, pelvis at PELVIS_Y) ---
/** Thigh length (hip→knee). */
const THIGH_LEN = 0.085;
/** Shin length (knee→ankle). */
const SHIN_LEN = 0.085;
/** Pelvis (hip) height above the feet — the body group's origin. */
const PELVIS_Y = THIGH_LEN + SHIN_LEN; // 0.17
/** Torso height (waist→shoulder). */
const TORSO_LEN = 0.115;
/** Torso depth (front→back). */
const TORSO_DEPTH = 0.072;
/** Half the lateral spacing of the hips. */
const HIP_X = 0.038;
/** Shoulder height above the pelvis (= top of the torso). */
const SHOULDER_Y = TORSO_LEN; // arms hang from the shoulder line
/** Half the lateral spacing of the shoulders. */
const SHOULDER_X = 0.058;
/** Upper-arm length (shoulder→elbow). */
const UPPER_LEN = 0.07;
/** Forearm length (elbow→wrist). */
const FORE_LEN = 0.065;
// Head block (beveled helmet).
const HEAD_W = 0.062;
const HEAD_H = 0.064;
const HEAD_D = 0.06;
const HEAD_BEVEL = 0.013;
/** Head center height (sits just above the shoulders with a tiny neck gap). */
const HEAD_Y = TORSO_LEN + 0.01 + HEAD_H * 0.5;
/** Sash / beacon vertical placement on the torso (fraction of TORSO_LEN). */
const SASH_Y_FRAC = 0.5;
const BEACON_Y_FRAC = 0.72;

// --- Walk-cycle tuning (radians / scene units; figure ~0.34 tall) ---
const TAU = Math.PI * 2;
/** Distance travelled per full stride cycle — sets the step cadence. */
const STRIDE = 0.3;
const HIP_AMP = 0.5;
/** Resting knee bend (legs never lock straight) plus swing-lift amplitude. */
const KNEE_REST = 0.12;
const KNEE_AMP = 0.5;
const SHOULDER_AMP = 0.42;
const ELBOW_REST = 0.22;
const ELBOW_AMP = 0.18;
/** Constant forward trunk lean while walking. */
const LEAN_FORWARD = 0.09;
/** Lateral weight-shift sway while walking. */
const TORSO_SWAY = 0.03;
const BOB_AMP_WALK = 0.012;
/** Walk speed floor (base units / second). */
const WALK_SPEED_MIN = 0.1;
/** Walk speed range above the floor — varied gentle paces. */
const WALK_SPEED_DELTA = 0.08;

// --- Idle tuning ---
const IDLE_BOB_FREQ = 1.3;
const IDLE_BOB_AMP = 0.005;
const IDLE_SWAY_FREQ = 0.9;
const IDLE_SWAY_AMP = 0.03;

/** Shared fallback point for the (rare) no-waypoint case — never mutated. */
const ORIGIN = new Vector3(0, 0, 0);

/** A walkable edge between two waypoints. */
interface Segment {
  readonly from: Vector3;
  readonly to: Vector3;
  readonly length: number;
}

/** Articulated joints of one figure — mutated in place by tick/pose helpers. */
interface RigJoints {
  /** Trunk (torso/head/arms) — carries the forward lean + sway. */
  readonly trunk: Group;
  readonly hipL: Group;
  readonly hipR: Group;
  readonly kneeL: Group;
  readonly kneeR: Group;
  readonly shoulderL: Group;
  readonly shoulderR: Group;
  readonly elbowL: Group;
  readonly elbowR: Group;
}

/** Per-figure state, allocated once at construction. */
interface CrewMember {
  /** The figure's transform root; tick mutates its position/rotation. */
  readonly actor: Group;
  /** True = walks the loop; false = idles at {@link idlePos}. */
  readonly walking: boolean;
  /** Walk speed (units/sec). Walkers only. */
  readonly speed: number;
  /** Distance offset along the loop, spreading figures out. Walkers only. */
  readonly offset: number;
  /** Phase offset for idle breathing/sway. */
  readonly bobPhase: number;
  /** Fixed world position for idle figures. */
  readonly idlePos: Vector3;
  /** Joint handles for the walk/idle pose. */
  readonly rig: RigJoints;
}

/**
 * Deterministic linear-congruential generator (Numerical Recipes constants).
 * Returns floats in [0, 1). `Math.imul` keeps the 32-bit multiply well-defined
 * across platforms; the state is seeded from the caller's seed.
 */
function makeLcg(seed: number): () => number {
  let state = (seed >>> 0) || 1;
  return (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state * 2.3283064365386963e-10; // divide by 2^32
  };
}

/** Clamp the requested count to the valid pool range. */
function clampCount(count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.min(MAX_CREW, Math.floor(count));
}

/**
 * How many of the crew idle in place ("a couple"). Scales down for tiny counts
 * so at least one figure still walks.
 */
function decideIdle(count: number): number {
  if (count >= 5) return 2;
  if (count >= 2) return 1;
  return 0;
}

/**
 * Build the walkable segment list from the waypoint loop. Zero-length edges
 * (duplicate/coinsident points) are dropped so a walker can never get stuck
 * draining distance against a degenerate segment. The path closes last→first.
 */
function buildSegments(waypoints: Vector3[]): { segments: Segment[]; totalLength: number } {
  const segments: Segment[] = [];
  let totalLength = 0;
  const n = waypoints.length;
  if (n >= 2) {
    for (let i = 0; i < n; i++) {
      const from = waypoints[i]!;
      const to = waypoints[(i + 1) % n]!;
      const length = from.distanceTo(to);
      if (length > 1e-6) {
        segments.push({ from, to, length });
        totalLength += length;
      }
    }
  }
  return { segments, totalLength };
}

/**
 * Paint a small woven-fabric canvas for the crew coveralls and wrap it as a
 * color texture. People-domain cloth (baseTextures covers architecture), so it
 * lives here; the base tone is derived from the frozen palette (steelEdge
 * muted toward concrete) so figures read against dark floors and harmonize
 * with the steel architecture. Returns the texture plus the underlying canvas
 * 2D context's color hex (unused by caller; kept out of the return). The
 * caller owns disposal of both the texture and the material built from it.
 */
function makeCoverallsCanvas(): HTMLCanvasElement {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext("2d");
  if (g) {
    const base = new Color(BASE_PALETTE.steelEdge).lerp(new Color(BASE_PALETTE.concrete), 0.45);
    const hi = base.clone().offsetHSL(0, 0, 0.06);
    const lo = base.clone().offsetHSL(0, 0, -0.08);
    g.fillStyle = `#${base.getHexString()}`;
    g.fillRect(0, 0, size, size);
    // Woven dobby: 8px tiles alternating two tones — reads as cloth up close.
    const tile = 8;
    for (let y = 0; y < size; y += tile) {
      for (let x = 0; x < size; x += tile) {
        const checker = ((x / tile) + (y / tile)) % 2 === 0;
        const thread = ((x / tile) % 2) === 0;
        g.fillStyle = `#${(checker ? hi : lo).getHexString()}`;
        g.globalAlpha = thread ? 0.5 : 0.28;
        // Horizontal threads on even rows, vertical on odd → woven cross.
        if ((y / tile) % 2 === 0) {
          g.fillRect(x, y + 1, tile, tile - 2);
        } else {
          g.fillRect(x + 1, y, tile - 2, tile);
        }
      }
    }
    g.globalAlpha = 1;
    // Subtle grime noise so the fabric isn't CGI-flat.
    const img = g.getImageData(0, 0, size, size);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (Math.random() * 24 - 12) | 0;
      d[i] = Math.max(0, Math.min(255, d[i]! + n));
      d[i + 1] = Math.max(0, Math.min(255, d[i + 1]! + n));
      d[i + 2] = Math.max(0, Math.min(255, d[i + 2]! + n));
    }
    g.putImageData(img, 0, 0);
  }
  return canvas;
}

/**
 * A pooled, deterministic crew of low-poly humanoid personnel that walk/idle a
 * waypoint loop. Add {@link group} to the scene, drive {@link tick} each
 * frame, and call {@link dispose} on teardown.
 */
export class CrewSystem {
  /** Root group holding every figure — add this to the scene. */
  public readonly group: Group;

  private readonly members: CrewMember[] = [];
  private readonly segments: Segment[];
  private readonly totalLength: number;
  private elapsedSec = 0;
  private disposed = false;

  // Instance-owned, shared-across-figures GPU resources (freed in dispose).
  private readonly headGeo: RoundedBoxGeometry;
  private readonly visorGeo: BoxGeometry;
  private readonly torsoGeo: ExtrudeGeometry;
  private readonly upperArmGeo: CylinderGeometry;
  private readonly foreArmGeo: CylinderGeometry;
  private readonly thighGeo: CylinderGeometry;
  private readonly shinGeo: CylinderGeometry;
  private readonly sashGeo: BoxGeometry;
  private readonly beaconGeo: SphereGeometry;
  private readonly coverallsCanvas: HTMLCanvasElement;
  private readonly coverallsTex: CanvasTexture;
  private readonly coverallsMat: MeshStandardMaterial;
  // baseTextures materials (helmet/visor/sash/beacon) are shared module caches
  // — NOT disposed here (see file header).
  private readonly helmetMat: MeshStandardMaterial;
  private readonly visorMat: MeshStandardMaterial;
  private readonly sashMat: MeshStandardMaterial;
  private readonly beaconMat: MeshStandardMaterial;

  constructor(opts: CrewOptions) {
    this.group = new Group();
    this.group.name = "crew";

    // --- Shared geometry (one set per instance, reused by every figure) ---
    this.headGeo = new RoundedBoxGeometry(HEAD_W, HEAD_H, HEAD_D, 3, HEAD_BEVEL);
    this.visorGeo = new BoxGeometry(HEAD_W * 0.72, HEAD_H * 0.22, 0.012);
    // Tapered torso: extrude a waist→shoulder silhouette with a chamfer bevel.
    // Shape wound COUNTER-CLOCKWISE so ExtrudeGeometry's +Z cap (the torso
    // front, where the sash/beacon/visor sit) faces outward — a CW shape would
    // leave the front inside-out and culled under FrontSide.
    const torsoShape = new Shape();
    const wWaist = 0.046;
    const wShoulder = 0.062;
    torsoShape.moveTo(-wWaist, 0);
    torsoShape.lineTo(wWaist, 0);
    torsoShape.quadraticCurveTo(wShoulder * 1.03, TORSO_LEN * 0.55, wShoulder, TORSO_LEN);
    torsoShape.lineTo(-wShoulder, TORSO_LEN);
    torsoShape.quadraticCurveTo(-wShoulder * 1.03, TORSO_LEN * 0.55, -wWaist, 0);
    this.torsoGeo = new ExtrudeGeometry(torsoShape, {
      depth: TORSO_DEPTH,
      bevelEnabled: true,
      bevelThickness: 0.008,
      bevelSize: 0.008,
      bevelSegments: 2,
      steps: 1,
    });
    this.torsoGeo.translate(0, 0, -TORSO_DEPTH / 2); // center depth on z=0
    this.upperArmGeo = new CylinderGeometry(0.018, 0.015, UPPER_LEN, 8);
    this.foreArmGeo = new CylinderGeometry(0.015, 0.012, FORE_LEN, 8);
    this.thighGeo = new CylinderGeometry(0.026, 0.02, THIGH_LEN, 8);
    // Shin flares slightly at the ankle to read as a boot.
    this.shinGeo = new CylinderGeometry(0.019, 0.024, SHIN_LEN, 8);
    this.sashGeo = new BoxGeometry(TORSO_LEN * 0.95, 0.014, 0.022);
    this.beaconGeo = new SphereGeometry(0.012, 10, 8);

    // --- Coveralls: woven canvas texture on a palette-derived PBR material. ---
    this.coverallsCanvas = makeCoverallsCanvas();
    this.coverallsTex = new CanvasTexture(this.coverallsCanvas);
    this.coverallsTex.anisotropy = 4;
    this.coverallsMat = new MeshStandardMaterial({
      map: this.coverallsTex,
      color: 0xffffff,
      roughness: 0.82,
      metalness: 0.04,
    });

    // --- Shared materials (baseTextures vocabulary: metal helmet + accents). ---
    this.helmetMat = wornSteelMaterial();
    this.visorMat = accentEmissive(BASE_PALETTE.accent.lab, 1.8);
    this.sashMat = accentEmissive(BASE_PALETTE.accent.hangar, 1.4);
    this.beaconMat = accentEmissive(BASE_PALETTE.accent.hangar, 2.2);

    const built = buildSegments(opts.waypoints);
    this.segments = built.segments;
    this.totalLength = built.totalLength;

    this.spawn(opts);
    // Place everyone at their starting pose so the first rendered frame (before
    // the first external tick) isn't clumped at the origin / in the T-pose.
    this.tick(0);
  }

  private spawn(opts: CrewOptions): void {
    const rng = makeLcg(opts.seed);
    const count = clampCount(opts.count);
    if (count === 0) return;

    const canWalk = this.totalLength > 1e-6;
    const idleCount = canWalk ? decideIdle(count) : count;
    const walkCount = count - idleCount;

    for (let i = 0; i < count; i++) {
      const built = this.buildFigure();
      const walking = canWalk && i < walkCount;
      const member = walking
        ? this.makeWalker(built.actor, built.rig, rng)
        : this.makeIdle(built.actor, built.rig, opts.waypoints, rng);
      this.members.push(member);
      this.group.add(built.actor);
    }
  }

  /**
   * Build one low-poly humanoid figure: beveled helmet + visor, tapered extruded
   * torso with diagonal sash + chest beacon, and articulated arms/legs hung
   * from joint pivots. Feet at y=0; returns the actor root + rig joint handles.
   */
  private buildFigure(): { actor: Group; rig: RigJoints } {
    const actor = new Group();
    // body sits at pelvis height; legs hang below, trunk+arms rise above.
    const body = new Group();
    body.position.y = PELVIS_Y;
    actor.add(body);

    // Legs (hang from the pelvis, unaffected by trunk lean).
    const legL = this.buildLeg(-HIP_X);
    const legR = this.buildLeg(HIP_X);
    body.add(legL.hip, legR.hip);

    // Trunk — tilts forward (lean) and sways; holds torso, head, arms.
    const trunk = new Group();
    body.add(trunk);

    const torso = new Mesh(this.torsoGeo, this.coverallsMat);
    torso.castShadow = true;
    trunk.add(torso);

    // Diagonal accent sash across the chest (bandolier strap).
    const sash = new Mesh(this.sashGeo, this.sashMat);
    sash.position.set(0, TORSO_LEN * SASH_Y_FRAC, TORSO_DEPTH * 0.5);
    sash.rotation.z = 0.5;
    trunk.add(sash);

    // High-vis chest beacon on the front.
    const beacon = new Mesh(this.beaconGeo, this.beaconMat);
    beacon.position.set(0.012, TORSO_LEN * BEACON_Y_FRAC, TORSO_DEPTH * 0.52);
    trunk.add(beacon);

    // Beveled helmet head + glowing visor slit.
    const head = new Mesh(this.headGeo, this.helmetMat);
    head.position.y = HEAD_Y;
    head.castShadow = true;
    trunk.add(head);
    const visor = new Mesh(this.visorGeo, this.visorMat);
    visor.position.set(0, HEAD_Y + 0.004, HEAD_D * 0.5);
    trunk.add(visor);

    // Arms (hang from the shoulders, swing with the trunk).
    const armL = this.buildArm(-SHOULDER_X);
    const armR = this.buildArm(SHOULDER_X);
    trunk.add(armL.shoulder, armR.shoulder);

    const rig: RigJoints = {
      trunk,
      hipL: legL.hip,
      hipR: legR.hip,
      kneeL: legL.knee,
      kneeR: legR.knee,
      shoulderL: armL.shoulder,
      shoulderR: armR.shoulder,
      elbowL: armL.elbow,
      elbowR: armR.elbow,
    };
    return { actor, rig };
  }

  /** Build one leg (thigh + shin) hung from a hip pivot group. */
  private buildLeg(xSign: number): { hip: Group; knee: Group } {
    const hip = new Group();
    hip.position.set(xSign * HIP_X, 0, 0);
    const thigh = new Mesh(this.thighGeo, this.coverallsMat);
    thigh.position.y = -THIGH_LEN * 0.5;
    thigh.castShadow = true;
    hip.add(thigh);
    const knee = new Group();
    knee.position.y = -THIGH_LEN;
    const shin = new Mesh(this.shinGeo, this.coverallsMat);
    shin.position.y = -SHIN_LEN * 0.5;
    shin.castShadow = true;
    knee.add(shin);
    hip.add(knee);
    return { hip, knee };
  }

  /** Build one arm (upper + fore) hung from a shoulder pivot group. */
  private buildArm(xSign: number): { shoulder: Group; elbow: Group } {
    const shoulder = new Group();
    shoulder.position.set(xSign * SHOULDER_X, SHOULDER_Y, 0);
    const upper = new Mesh(this.upperArmGeo, this.coverallsMat);
    upper.position.y = -UPPER_LEN * 0.5;
    upper.castShadow = true;
    shoulder.add(upper);
    const elbow = new Group();
    elbow.position.y = -UPPER_LEN;
    const fore = new Mesh(this.foreArmGeo, this.coverallsMat);
    fore.position.y = -FORE_LEN * 0.5;
    fore.castShadow = true;
    elbow.add(fore);
    shoulder.add(elbow);
    return { shoulder, elbow };
  }

  private makeWalker(actor: Group, rig: RigJoints, rng: () => number): CrewMember {
    const speed = WALK_SPEED_MIN + rng() * WALK_SPEED_DELTA;
    const offset = this.totalLength > 0 ? rng() * this.totalLength : 0;
    const bobPhase = rng() * TAU;
    poseWalk(rig, (offset / STRIDE) * TAU);
    return { actor, rig, walking: true, speed, offset, bobPhase, idlePos: ORIGIN };
  }

  private makeIdle(
    actor: Group,
    rig: RigJoints,
    waypoints: Vector3[],
    rng: () => number,
  ): CrewMember {
    const pos = waypoints.length > 0 ? waypoints[Math.floor(rng() * waypoints.length)]! : ORIGIN;
    actor.position.copy(pos);
    actor.rotation.y = rng() * TAU;
    const bobPhase = rng() * TAU;
    poseIdle(rig, 0, bobPhase);
    return { actor, rig, walking: false, speed: 0, offset: 0, bobPhase, idlePos: pos };
  }

  /**
   * Advance the crew by `dtMs` milliseconds. Allocation-free: only pre-built
   * joint rotations/positions are mutated. Walkers travel the loop with a full
   * stride cycle (legs/arms/bob/lean) and turn to face their travel direction;
   * idle figures hold a relaxed stance with a gentle sway + breathing bob.
   */
  tick(dtMs: number): void {
    if (this.disposed || this.members.length === 0) return;
    const dt = dtMs > 0 ? dtMs * 0.001 : 0;
    this.elapsedSec += dt;
    const t = this.elapsedSec;
    const segs = this.segments;
    const total = this.totalLength;

    for (let i = 0; i < this.members.length; i++) {
      const m = this.members[i]!;
      if (m.walking) {
        if (total <= 1e-6) {
          // No path to walk — fall back to an idle pose so the figure still
          // looks alive instead of frozen mid-stride.
          m.actor.position.y = m.idlePos.y + Math.sin(t * IDLE_BOB_FREQ + m.bobPhase) * IDLE_BOB_AMP;
          poseIdle(m.rig, t, m.bobPhase);
          continue;
        }
        const d = t * m.speed + m.offset; // continuous distance (monotonic phase)
        let dist = d % total; // wrapped position along the loop
        for (let s = 0; s < segs.length; s++) {
          const seg = segs[s]!;
          if (dist > seg.length) {
            dist -= seg.length;
            continue;
          }
          const alpha = seg.length > 0 ? dist / seg.length : 0;
          const actor = m.actor;
          actor.position.lerpVectors(seg.from, seg.to, alpha);
          // Leg phase comes from distance travelled → feet plant, never slide.
          const phase = (d / STRIDE) * TAU;
          actor.position.y += Math.abs(Math.sin(phase)) * BOB_AMP_WALK;
          actor.rotation.y = Math.atan2(seg.to.x - seg.from.x, seg.to.z - seg.from.z);
          // Per-figure stride phase already differs via m.offset (distance-based).
          poseWalk(m.rig, phase);
          break;
        }
      } else {
        const actor = m.actor;
        actor.position.x = m.idlePos.x;
        actor.position.z = m.idlePos.z;
        actor.position.y = m.idlePos.y + Math.sin(t * IDLE_BOB_FREQ + m.bobPhase) * IDLE_BOB_AMP;
        poseIdle(m.rig, t, m.bobPhase);
      }
    }
  }

  /** Detach the group and free the instance-owned geometry + coveralls resources. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.group.parent) this.group.parent.remove(this.group);
    this.group.clear();
    this.members.length = 0;
    this.headGeo.dispose();
    this.visorGeo.dispose();
    this.torsoGeo.dispose();
    this.upperArmGeo.dispose();
    this.foreArmGeo.dispose();
    this.thighGeo.dispose();
    this.shinGeo.dispose();
    this.sashGeo.dispose();
    this.beaconGeo.dispose();
    this.coverallsTex.dispose();
    this.coverallsMat.dispose();
    // NOTE: helmet/visor/sash/beacon materials come from baseTextures and are
    // shared/cached — intentionally not disposed here.
  }
}

/**
 * Pose a figure mid-stride at `phase` (radians, distance-derived). Legs
 * alternate at the hip with a phase-coupled knee lift; arms counter-swing with
 * a bent elbow; the trunk leans forward and shifts laterally with the gait.
 * Pure scalar mutation — no allocation.
 */
function poseWalk(rig: RigJoints, phase: number): void {
  const legLph = phase;
  const legRph = phase + Math.PI;
  rig.hipL.rotation.x = Math.sin(legLph) * HIP_AMP;
  rig.hipR.rotation.x = Math.sin(legRph) * HIP_AMP;
  rig.kneeL.rotation.x = KNEE_REST + Math.max(0, Math.sin(legLph - 0.6)) * KNEE_AMP;
  rig.kneeR.rotation.x = KNEE_REST + Math.max(0, Math.sin(legRph - 0.6)) * KNEE_AMP;
  const armLph = phase + Math.PI; // arms counter-swing the legs
  const armRph = phase;
  rig.shoulderL.rotation.x = Math.sin(armLph) * SHOULDER_AMP;
  rig.shoulderR.rotation.x = Math.sin(armRph) * SHOULDER_AMP;
  rig.elbowL.rotation.x = ELBOW_REST + Math.max(0, Math.sin(armLph + 0.4)) * ELBOW_AMP;
  rig.elbowR.rotation.x = ELBOW_REST + Math.max(0, Math.sin(armRph + 0.4)) * ELBOW_AMP;
  rig.trunk.rotation.x = LEAN_FORWARD;
  rig.trunk.rotation.z = Math.sin(phase) * TORSO_SWAY;
}

/**
 * Pose an idle figure at time `t`: relaxed stance (slight leg spread, resting
 * arms) with a gentle lateral sway + faint forward lean. Pure scalar mutation.
 */
function poseIdle(rig: RigJoints, t: number, bobPhase: number): void {
  rig.hipL.rotation.x = 0.05;
  rig.hipR.rotation.x = -0.05;
  rig.kneeL.rotation.x = KNEE_REST;
  rig.kneeR.rotation.x = KNEE_REST;
  rig.shoulderL.rotation.x = -0.06;
  rig.shoulderR.rotation.x = 0.06;
  rig.elbowL.rotation.x = ELBOW_REST;
  rig.elbowR.rotation.x = ELBOW_REST;
  rig.trunk.rotation.x = 0.04;
  rig.trunk.rotation.z = Math.sin(t * IDLE_SWAY_FREQ + bobPhase) * IDLE_SWAY_AMP;
}
