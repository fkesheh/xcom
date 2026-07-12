---
type: investigation
symptom: "for some reason artartica looks off"
slug: antarctica-cloud-cap
date: 2026-07-11T07:31:00-03:00
investigator: Foad Kesheh
git_commit: 219372a16124add9d6554f2eb9b8a4dd14e63d6e
branch: main
repository: fkesheh/xcom
status: resolved
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
---

# Antarctica is covered by an artificial bright cap

## Symptom

- **Observed**: “for some reason artartica looks off”; the browser capture at
  `tests/smoke-shots/08-geoscape-time.png` shows an unusually bright, smeared
  southern polar edge.
- **Expected**: Antarctica should use the same satellite surface and relief treatment
  as the other continents, with clouds remaining a sparse translucent layer.
- **Delta**: the southern polar region receives much more cloud opacity than the
  middle latitudes and loses readable land detail.

## Reproduction

1. Run the geoscape smoke capture:
   `npx playwright test tests/smoke.spec.ts --project=chromium --grep 'Pause/1x/5x/30x'`.
2. Inspect `tests/smoke-shots/08-geoscape-time.png` and the south edge of the globe.
3. Measure the luma used as alpha in the cloud map:

   ```text
   south:  lavfi.signalstats.YAVG=130.099
   center: lavfi.signalstats.YAVG=49.629
   ```

Verified 2026-07-11: the south strip is 2.62× brighter than the equatorial strip.

## Hypotheses

#### H1: Thermal/ice brightness in the NASA cloud composite is being interpreted directly as cloud opacity at Antarctica

- **Layer**: state-data / integration
- **Prediction**: the cloud image's southern strip will be much brighter than its
  center, and the renderer will use that brightness unmodified as `alphaMap`.
- **Verification method**: compare strip luma with FFmpeg `signalstats`; inspect the
  material setup.
- **Evidence**:

  ```text
  south mean: lavfi.signalstats.YAVG=130.099
  equator mean: lavfi.signalstats.YAVG=49.629

  src/game/geoscape.ts:2013-2016
  color: 0xeaf8ff,
  alphaMap: cloudTexture,
  transparent: true,
  opacity: 0.26,
  ```

- **Verdict**: PROVEN
- **Rationale**: a grayscale value used as `alphaMap` maps brighter polar ice/thermal
  content directly to higher opacity; the 2.62× south/equator ratio predicts the
  observed cap.

#### H2: The globe mesh lacks enough polar geometry and visibly facets Antarctica

- **Layer**: code-logic
- **Prediction**: the globe would use a low segment count and the defect would follow
  polygon edges on both the surface and cloud shells.
- **Verification method**: inspect sphere construction and the capture.
- **Evidence**:

  ```text
  src/game/geoscape.ts:2001 SphereGeometry(EARTH_RADIUS, 128, 80)
  src/game/geoscape.ts:2011 SphereGeometry(EARTH_RADIUS + 0.045, 96, 56)
  ```

- **Verdict**: REJECTED
- **Rationale**: both meshes have far more segments than the visible scale requires;
  the artifact follows the bright texture band, not triangle edges.

#### H3: A non-equirectangular or mismatched surface map distorts Antarctica

- **Layer**: configuration / asset integration
- **Prediction**: the surface, normal, or specular maps would have a non-2:1 aspect
  ratio or visibly misaligned coastlines.
- **Verification method**: inspect the three source maps and rendered coast alignment.
- **Evidence**:

  ```text
  earth-day-2048.jpg       2048×1024
  earth-normal-2048.jpg    2048×1024
  earth-specular-2048.jpg  2048×1024
  ```

- **Verdict**: REJECTED
- **Rationale**: all surface layers use the expected 2:1 equirectangular layout and
  their coastlines align in the browser capture.

## 5 Whys

Symptom: Antarctica appears as an unnatural bright/smeared cap.

1. Because the cloud shell is much more opaque over the south pole.
2. Because the renderer uses grayscale cloud-map brightness directly as alpha.
3. Because the NASA composite contains thermal/ice brightness over the poles in
   addition to visible cloud brightness.
4. Because a scientific composite was integrated as if it were a pre-cleaned alpha
   mask.
5. Because the asset boundary had no normalization step for separating polar ground
   brightness from atmospheric cloud opacity.

## Falsification

- **Check performed**: adjacent-cause and spatial counterexample.
- **Result**: the same sphere geometry renders aligned coastlines at equatorial and
  northern latitudes, while only the area where cloud-map luma rises from 49.629 to
  130.099 develops the cap. The high-resolution mesh is present under both regions.
- **Conclusion**: H1 survives; geometry density and map projection do not explain the
  south-only opacity increase.

## Root Cause

- **Immediate cause**: `earth-clouds-2048.jpg` is used directly as `alphaMap`
  (`src/game/geoscape.ts:2013-2016`) even though its southern polar brightness is
  2.62× its equatorial average.
- **Architectural root**: external scientific texture channels were accepted without
  an asset-specific normalization/masking stage.
- **Rejected H2**: both globe shells are sufficiently tessellated and the artifact
  does not follow facets.
- **Rejected H3**: all physical maps are aligned 2:1 equirectangular textures.

## Fix

- Preprocess the cloud alpha into a game-ready texture that suppresses polar ground
  brightness while preserving mid-latitude weather systems.
- Add a regression test comparing southern-cap opacity against the source composite.

## Resolution

- Generated `public/assets/earth-cloud-alpha-2048.jpg` with background suppression
  and a polar fade; the south/equator mean-luma ratio fell from 2.62 to 1.15.
- `src/game/geoscape.ts` now uses the normalized alpha asset.
- Regression: `tests/globe-assets.spec.ts` requires the ratio to remain below 1.5.
