---
type: investigation
symptom: "radar (2 circles) while the plane flight is on vertical (earth to space) should it be horizontal (paralel to earth surface)?"
slug: interceptor-radar-ring-vertical
date: 2026-07-12T00:00:00-03:00
investigator: Foad Kesheh
git_commit: 790c3fc8404cd289226c742dfa0776773c7e4480
branch: main
repository: fkesheh/xcom
status: resolved
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
related:
  - docs/investigations/2026-07-11-geoscape-5x-marker-jumps.md
---

# Interceptor radar rings stand vertically instead of following Earth

## Symptom

- **Observed**: “radar (2 circles) while the plane flight is on vertical (earth to
  space) should it be horizontal (paralel to earth surface)?” Both rings appear in a
  vertical plane aligned with flight direction.
- **Expected**: both the close craft indicator and wide radar footprint remain tangent
  to the globe, parallel to the local Earth surface.
- **Delta**: ring normals point along the flight tangent rather than the local surface normal.

## Reproduction

1. Dispatch an interceptor area patrol from the geoscape.
2. Observe its close indicator ring and wide radar ring while the fighter moves.
3. Reproduce the exact transform numerically using the marker basis from
   `orientMarker` and the rings' authored `rotation.x = -PI/2`.

   ```text
   dot(rotated ring normal, surface normal)= 0.000000
   dot(unrotated ring normal, surface normal)= 1.000000
   dot(rotated ring normal, flight tangent)= 1.000000
   ```

Verified 2026-07-12: the current rotation makes the ring normal exactly tangent to
Earth and exactly parallel to flight direction.

## Hypotheses

#### H1: The rings apply an unnecessary -90° local X rotation after the parent marker already defines a tangent XY plane

- **Layer**: code-logic
- **Prediction**: the rotation maps the default RingGeometry +Z normal onto local +Y;
  the marker basis then maps local +Y to flight tangent. Removing it maps +Z directly
  to the surface normal.
- **Verification method**: inspect ring construction and `orientMarker`; reproduce the
  quaternion/basis transform with Three.js vectors.
- **Evidence**:

  ```text
  src/game/geoscape.ts:3442 ring.rotation.x = -Math.PI / 2
  src/game/geoscape.ts:3457 radarRing.rotation.x = -Math.PI / 2
  src/game/geoscape.ts:4241 makeBasis(..., tangent, posN)

  rotated normal · surface normal = 0.000000
  unrotated normal · surface normal = 1.000000
  rotated normal · flight tangent = 1.000000
  ```

- **Verdict**: PROVEN
- **Rationale**: the transforms force the current ring plane to be perpendicular to
  the surface; the unrotated RingGeometry is already exactly tangent.

#### H2: `orientMarker` incorrectly points the entire aircraft away from Earth

- **Layer**: code-logic
- **Prediction**: the parent basis would not map local +Z to `posN`, and the aircraft's
  local XY body plane would also be radial/vertical.
- **Verification method**: inspect `makeBasis` column assignment and transform local +Z.
- **Evidence**:

  ```text
  makeBasis(tangent × posN, tangent, posN)
  unrotated local +Z normal · surface normal = 1.000000
  ```

- **Verdict**: REJECTED
- **Rationale**: the parent marker basis correctly maps local +Z to the surface normal.

#### H3: Camera perspective only makes an otherwise tangent circle appear vertical

- **Layer**: observation
- **Prediction**: world-space ring normal would still equal the surface normal even
  when the screen projection looked edge-on.
- **Verification method**: calculate world-space dot products independent of camera.
- **Evidence**:

  ```text
  current rotated ring normal · surface normal = 0.000000
  current rotated ring normal · flight tangent = 1.000000
  ```

- **Verdict**: REJECTED
- **Rationale**: the ring is objectively vertical in world space before camera projection.

## 5 Whys

1. The rings stand vertically because their normals align with flight tangent.
2. Their local geometry is rotated -90° around X.
3. That rotation assumes the parent local XY plane is not already tangent to Earth.
4. `buildFlightMarker` authored child orientation without respecting the coordinate
   contract established by `orientMarker`.
5. The marker assembly lacks an explicit invariant/test that surface-footprint
   decorations must keep their normal parallel to the local globe normal.

## Falsification

- **Check performed**: absence/counterfactual transform calculation.
- **Result**: with the exact same marker basis and globe position, omitting only the
  child X rotation changes the normal/surface dot product from 0 to 1. No camera or
  route state participates in the calculation.
- **Conclusion**: H1 survives; parent orientation and perspective are not causal.

## Root Cause

- **Immediate cause**: both ring children apply `rotation.x = -PI/2` even though
  RingGeometry's default XY plane is already the marker's Earth-tangent XY plane.
- **Architectural root**: child marker decorations did not follow or test the parent's
  local-axis contract (+Z = surface normal, +Y = flight direction).
- **Rejected H2**: `orientMarker` maps local +Z exactly to `posN`.
- **Rejected H3**: world-space math proves the error before projection.

## Fix

- Remove both local X rotations so ring normals inherit the marker's +Z surface normal.
- Add a deterministic regression test for the marker/ring orientation invariant.

## Resolution

- Removed the `-PI/2` child rotation from both the close flight indicator and wide
  onboard-radar footprint in `src/game/geoscape.ts`.
- Named both meshes and extended the read-only marker probe to report each ring's
  world-normal dot product against the local Earth normal.
- Regression: `tests/radar-orientation.spec.ts` requires both alignments to exceed
  `0.999`; the original transform measured `0.000000`, while the corrected transform
  and browser render pass.
- Verification: production TypeScript/Vite build passes, Playwright regression passes,
  and `git diff --check` reports no errors.
