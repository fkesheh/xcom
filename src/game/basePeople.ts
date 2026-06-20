/**
 * Animated crew system for the base "cutaway" diorama (Layer 2). Small low-poly
 * personnel that walk the corridor waypoint loop (or idle in place) so the base
 * reads as a living, populated facility instead of a static model.
 *
 * Art vocabulary is frozen in basePalette.ts: coveralls trace to
 * BASE_PALETTE.steelEdge (the lightest structural grey, so the figures pop
 * against the dark concrete floors) and the accent sash uses accentMaterial.
 * No ad-hoc hex anywhere. Material model is stylized PBR (MeshStandardMaterial).
 *
 * Determinism: all placement / speed / phase decisions flow from a seeded LCG
 * (Numerical-Recipes constants) built from `opts.seed` — NEVER Math.random, so
 * the same base always populates identically.
 *
 * Performance: the count is capped (<=12), geometries + materials are created
 * once per instance and shared across every figure, and `tick` performs ZERO
 * allocation — it mutates pre-built figure transforms in place (lerpVectors is
 * allocation-free, bob/facing are scalar). dispose() detaches the group and
 * frees the instance-owned geometry/material resources.
 *
 * Figures are ~0.33 tall (a tapered pale coverall body + head + a bright
 * emissive sash + a small high-vis beacon dot), origin at the feet, so a group
 * positioned at a waypoint stands on the floor. They cast shadows to sell
 * contact with the ground and pop against the dark concrete at hero distance.
 */
import {
  CylinderGeometry,
  Color,
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  Vector3,
} from "three";
import { accentMaterial, BASE_PALETTE } from "./basePalette";

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

// --- Figure proportions (total height ~0.35, enlarged to read at hero distance) ---
const BODY_HEIGHT = 0.225;
const BODY_TOP_R = 0.054;
const BODY_BOTTOM_R = 0.08;
const HEAD_R = 0.062;
const SASH_R = 0.075;
const SASH_H = 0.036;
/** High-vis chest beacon radius — a bright point so each figure reads as a person. */
const BEACON_R = 0.034;

// --- Motion tuning ---
const TAU = Math.PI * 2;
/** Walk speed floor (bay units / second). */
const WALK_SPEED_MIN = 0.1;
/** Walk speed range above the floor — varied gentle paces. */
const WALK_SPEED_DELTA = 0.08;
/** Vertical bob frequency (rad/sec) while walking. */
const BOB_FREQ = 7.5;
const BOB_AMP_WALK = 0.016;
const BOB_AMP_IDLE = 0.006;

/** Shared fallback point for the (rare) no-waypoint case — never mutated. */
const ORIGIN = new Vector3(0, 0, 0);

/** A walkable edge between two waypoints. */
interface Segment {
  readonly from: Vector3;
  readonly to: Vector3;
  readonly length: number;
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
  /** Phase offset for the vertical bob. */
  readonly bobPhase: number;
  /** Fixed world position for idle figures. */
  readonly idlePos: Vector3;
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
 * A pooled, deterministic crew of low-poly personnel that walk/idle a waypoint
 * loop. Add {@link group} to the scene, drive {@link tick} each frame, and call
 * {@link dispose} on teardown.
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
  private readonly bodyGeo: CylinderGeometry;
  private readonly headGeo: SphereGeometry;
  private readonly sashGeo: CylinderGeometry;
  private readonly beaconGeo: SphereGeometry;
  private readonly coverallsMat: MeshStandardMaterial;
  private readonly sashMat: MeshStandardMaterial;
  private readonly beaconMat: MeshStandardMaterial;

  constructor(opts: CrewOptions) {
    this.group = new Group();
    this.group.name = "crew";

    // Shared geometry/material — one set per instance, reused by every figure.
    this.bodyGeo = new CylinderGeometry(BODY_TOP_R, BODY_BOTTOM_R, BODY_HEIGHT, 12);
    this.headGeo = new SphereGeometry(HEAD_R, 12, 10);
    this.sashGeo = new CylinderGeometry(SASH_R, SASH_R, SASH_H, 14);
    this.beaconGeo = new SphereGeometry(BEACON_R, 10, 8);
    // Pale high-contrast coveralls — the lightest palette tone lifted toward
    // white and given a faint self-emission so the figure never disappears
    // into shadow against the dark concrete. Stylized PBR, palette-derived only.
    const coverallsColor = new Color(BASE_PALETTE.steelEdge).lerp(new Color(1, 1, 1), 0.55);
    this.coverallsMat = new MeshStandardMaterial({
      color: coverallsColor,
      emissive: coverallsColor,
      emissiveIntensity: 0.18,
      metalness: 0.05,
      roughness: 0.7,
    });
    // Bright accent sash — a vivid emissive band (X-COM operational green) so
    // the torso reads as a person, not a blob, at gameplay distance.
    this.sashMat = accentMaterial("hangar", 1.5);
    // High-vis chest beacon — a small bright point on the figure front. Kept
    // below the bleach threshold of the ACES tone mapper so it reads GREEN
    // (a colored dot) rather than washing out to white against the pale body.
    this.beaconMat = accentMaterial("hangar", 1.9);

    const built = buildSegments(opts.waypoints);
    this.segments = built.segments;
    this.totalLength = built.totalLength;

    this.spawn(opts);
    // Place everyone at their starting pose so the first rendered frame (before
    // the first external tick) isn't clumped at the origin.
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
      const actor = this.buildFigure();
      const walking = canWalk && i < walkCount;
      const member = walking
        ? this.makeWalker(actor, rng)
        : this.makeIdle(actor, opts.waypoints, rng);
      this.members.push(member);
      this.group.add(actor);
    }
  }

  /** Build one low-poly figure (tapered body + head + sash + beacon), feet at y=0. */
  private buildFigure(): Group {
    const fig = new Group();
    const body = new Mesh(this.bodyGeo, this.coverallsMat);
    body.position.y = BODY_HEIGHT * 0.5;
    body.castShadow = true;
    fig.add(body);
    const head = new Mesh(this.headGeo, this.coverallsMat);
    head.position.y = BODY_HEIGHT + HEAD_R;
    head.castShadow = true;
    fig.add(head);
    const sash = new Mesh(this.sashGeo, this.sashMat);
    sash.position.y = BODY_HEIGHT * 0.6;
    fig.add(sash);
    // High-vis beacon on the chest front — the bright point that catches the eye.
    const beacon = new Mesh(this.beaconGeo, this.beaconMat);
    beacon.position.set(0, BODY_HEIGHT * 0.6, BODY_BOTTOM_R * 0.85);
    fig.add(beacon);
    return fig;
  }

  private makeWalker(actor: Group, rng: () => number): CrewMember {
    const speed = WALK_SPEED_MIN + rng() * WALK_SPEED_DELTA;
    const offset = this.totalLength > 0 ? rng() * this.totalLength : 0;
    const bobPhase = rng() * TAU;
    return { actor, walking: true, speed, offset, bobPhase, idlePos: ORIGIN };
  }

  private makeIdle(actor: Group, waypoints: Vector3[], rng: () => number): CrewMember {
    const pos =
      waypoints.length > 0 ? waypoints[Math.floor(rng() * waypoints.length)]! : ORIGIN;
    actor.position.copy(pos);
    actor.rotation.y = rng() * TAU;
    return { actor, walking: false, speed: 0, offset: 0, bobPhase: rng() * TAU, idlePos: pos };
  }

  /**
   * Advance the crew by `dtMs` milliseconds. Allocation-free: position/rotation
   * are mutated in place. Walkers travel the loop with a vertical bob and turn
   * to face their travel direction; idle figures bob gently in place.
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
        if (total <= 1e-6) continue;
        // Distance along the loop, wrapped — mirrors baseView's walker model.
        let dist = (t * m.speed + m.offset) % total;
        for (let s = 0; s < segs.length; s++) {
          const seg = segs[s]!;
          if (dist > seg.length) {
            dist -= seg.length;
            continue;
          }
          const alpha = seg.length > 0 ? dist / seg.length : 0;
          const actor = m.actor;
          actor.position.lerpVectors(seg.from, seg.to, alpha);
          actor.position.y += Math.sin(t * BOB_FREQ + m.bobPhase) * BOB_AMP_WALK;
          actor.rotation.y = Math.atan2(seg.to.x - seg.from.x, seg.to.z - seg.from.z);
          break;
        }
      } else {
        m.actor.position.y = m.idlePos.y + Math.sin(t * BOB_FREQ * 0.6 + m.bobPhase) * BOB_AMP_IDLE;
      }
    }
  }

  /** Detach the group and free the instance-owned geometry/material resources. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.group.parent) this.group.parent.remove(this.group);
    this.group.clear();
    this.members.length = 0;
    this.bodyGeo.dispose();
    this.headGeo.dispose();
    this.sashGeo.dispose();
    this.beaconGeo.dispose();
    this.coverallsMat.dispose();
    this.sashMat.dispose();
    this.beaconMat.dispose();
  }
}
