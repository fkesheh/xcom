---
type: investigation
symptom: "ufo and interceptors on 5x jumps a bit while flighting, not very smooth"
slug: geoscape-5x-marker-jumps
date: 2026-07-11T07:39:00-03:00
investigator: Foad Kesheh
git_commit: 219372a16124add9d6554f2eb9b8a4dd14e63d6e
branch: main
repository: fkesheh/xcom
status: resolved
hypotheses_formed: 4
hypotheses_rejected: 3
hypotheses_proven: 1
---

# Airborne markers jump at 5× strategic ticks

## Symptom

- **Observed**: “ufo and interceptors on 5x jumps a bit while flighting, not very smooth”.
- **Expected**: UFO and interceptor markers advance continuously at 5×, including
  across strategic-state updates.
- **Delta**: per-frame interpolation is smooth between ticks, but the interceptor
  changes position abruptly when a 400ms campaign tick lands.

## Reproduction

1. Seed a tracked scout and launch an interception.
2. Keep the automatic 5× pursuit speed.
3. Sample `window.__geoMarkers()` every animation frame for 1.8 seconds.

   ```text
   tick=true  flight delta: 3.896, 4.619, 5.355, 6.071, 6.786 px
   tick=false typical flight delta: 0.267–0.558 px
   ```

Verified 2026-07-11 with `tests/smooth-probe.spec.ts`.

## Hypotheses

#### H1: Homing replaces the UFO endpoint but retains a progress fraction measured on the old great-circle route

- **Layer**: code-logic / state-data
- **Prediction**: large deltas occur specifically when elapsed campaign time changes,
  and the homing step mutates `toLat/toLon` without rebasing `fromLat/fromLon/progress`.
- **Verification method**: correlate sampled deltas with elapsed-hour changes; inspect
  the homing map in `manageActiveFlights`.
- **Evidence**:

  ```text
  largest five interceptor deltas: 3.896–6.786 px; every row has tick=true

  src/campaign/geoscape.ts:2145-2147
  isContactPatrolFlight(flight) && chasing
    ? { ...flight, toLat: contact!.lat, toLon: contact!.lon }
    : flight
  ```

- **Verdict**: REJECTED
- **Rationale**: rebasing the route from the live craft position left the measured
  tick jumps essentially unchanged (3.887–6.580 px), so endpoint retargeting was not
  the primary discontinuity.

#### H2: Low browser frame rate makes otherwise continuous motion look stepped

- **Layer**: tooling / observation
- **Prediction**: the largest deltas would correlate with long animation-frame gaps,
  not campaign tick boundaries.
- **Verification method**: sample every RAF and tag rows where elapsed campaign time changes.
- **Evidence**:

  ```text
  non-tick interceptor deltas remain 0.267–0.558 px;
  all five 3.896–6.786 px outliers are tick=true.
  ```

- **Verdict**: REJECTED
- **Rationale**: the discontinuity is state-update-bound, not frame-cadence-bound.

#### H3: 0.1-degree UFO coordinate rounding is the sole cause

- **Layer**: code-logic
- **Prediction**: only the UFO should make a small bounded correction; interceptor
  jumps should not dominate because its progress is not rounded.
- **Verification method**: compare craft and UFO outliers and inspect `moveTrackedContact`.
- **Evidence**:

  ```text
  tick outlier at 1767ms: interceptor=6.786 px, UFO=1.311 px
  moveTrackedContact rounds only contact lat/lon to 0.1 degrees.
  ```

- **Verdict**: REJECTED
- **Rationale**: rounding can explain a small UFO correction, not the much larger
  interceptor jump tied to route mutation.

#### H4: Render-side pursuit advances the craft at closing speed while campaign ticks advance it at full craft speed

- **Layer**: code-logic / integration
- **Prediction**: a Raptor chasing a scout will be interpolated at only 8°/h between
  ticks (36.2−28.2), then catch up to the campaign's 36.2°/h craft position each tick.
  Using full craft speed for interpolation will reduce tick deltas to normal-frame size.
- **Verification method**: inspect `smoothMarkers`, replace its pursuit-only
  closing-speed calculation with the same `flight.speedDegPerHour` used by campaign
  flight advancement, and repeat the identical probe.
- **Evidence**:

  ```text
  Before: tick flight deltas 3.896–6.786 px; ordinary frames 0.267–0.558 px.
  After:  max tick flight delta 1.519 px; max ordinary-frame delta 1.775 px.
  ```

- **Verdict**: PROVEN
- **Rationale**: aligning presentation and simulation speeds removed the tick-only
  outliers; tick motion is now no larger than ordinary per-frame motion.

## 5 Whys

1. The marker jumps because the authoritative tick position is ahead of the render prediction.
2. The render prediction advances a pursuing craft by range closing speed.
3. Closing speed subtracts UFO speed even though the UFO marker is already moved separately.
4. Simulation advances both bodies independently at their own speeds, but presentation
   mixed relative and absolute motion models.
5. The animation boundary lacked a shared invariant that each body always advances at
   its own physical speed.

## Falsification

- **Check performed**: counterfactual speed-model edit plus repeat measurement.
- **Result**: route rebasing alone did not improve the discontinuity, but changing only
  the render prediction from closing speed to craft speed reduced the maximum tick
  delta from 6.786 px to 1.519 px, below the 1.775 px ordinary-frame maximum.
- **Conclusion**: H4 survives; H1 is rejected as the primary cause.

## Root Cause

- **Immediate cause**: `smoothMarkers` advanced the interceptor with relative closing
  speed while `advanceFlightProgress` advanced it with absolute craft speed.
- **Architectural root**: simulation and presentation used different motion models for
  the same craft.
- **Rejected H1**: a position-preserving route rebase did not reduce tick deltas.
- **Rejected H2**: non-tick RAF samples are smooth.
- **Rejected H3**: contact rounding cannot cause the much larger craft displacement.

## Fix

- Advance every marker at its own physical speed; animate UFO motion separately.
- Keep position-preserving homing rebases so moving endpoints cannot introduce a
  secondary route-fraction discontinuity.
- Retain a browser regression probe that bounds tick deltas relative to normal frames.

## Resolution

- `src/game/geoscape.ts`: render interpolation now uses the flight's full cruise speed.
- `src/campaign/geoscape.ts`: homing retargets rebase from live position; UFO movement
  no longer rounds coordinates every strategic tick.
- Regression: `tests/geoscape-motion.spec.ts` asserts tick deltas remain within 1.5×
  normal-frame deltas for both fighter and UFO.
- Verification: before 6.786 px max tick jump; after 1.519 px, below ordinary-frame max.
