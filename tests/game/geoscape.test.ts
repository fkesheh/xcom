import { Vector2 } from "three";
import { describe, expect, it } from "vitest";

import {
  advanceGeoscape,
  CRASH_SITE_LIFETIME_HOURS,
  GEOSCAPE_SCAN_HOURS,
  interceptUfo,
  isInterceptorReady,
} from "../../src/campaign/geoscape";
import { createCampaign } from "../../src/campaign/storage";
import {
  canSelectBaseSite,
  detectGeoscapeEvent,
  geoscapeShouldDropToRealtime,
  geoscapeShouldForcePause,
  geoscapeTimeAction,
  regionFor,
  snapshotGeoscapeEvent,
  uvToLatLon,
} from "../../src/game/geoscape";
import type { CampaignState, UfoContact } from "../../src/campaign/types";

describe("geoscape coordinate picking", () => {
  it("maps sphere UV north/south in the same hemisphere as the visible map", () => {
    expect(uvToLatLon(new Vector2(0.5, 1)).lat).toBeCloseTo(90);
    expect(uvToLatLon(new Vector2(0.5, 0.5)).lat).toBeCloseTo(0);
    expect(uvToLatLon(new Vector2(0.5, 0)).lat).toBeCloseTo(-90);
  });

  it("keeps a Canada-like click in the northern hemisphere", () => {
    const selected = uvToLatLon(new Vector2((-96.4 + 180) / 360, (53.8 + 90) / 180));

    expect(selected.lat).toBeCloseTo(53.8);
    expect(selected.lon).toBeCloseTo(-96.4);
  });

  it("classifies Canadian and Central American selections separately", () => {
    expect(regionFor(53.8, -96.4)).toBe("North America");
    expect(regionFor(45.2, -69.7)).toBe("North America");
    expect(regionFor(15, -90)).toBe("Central America");
  });

  it("allows base placement only before the campaign exists", () => {
    const campaign = createCampaign({ lat: 2, lon: 14.2, region: "Africa" }, 12345);

    expect(canSelectBaseSite(null)).toBe(true);
    expect(canSelectBaseSite(campaign)).toBe(false);
  });

  it("keeps geoscape time advancement available while contacts are active", () => {
    // Month-0 contactInterval is stretched to round(18 * 1.6) = 29h (see the
    // arc-stretch ramp in contactInterval). Seed 98 rolls an easily-interceptable
    // scout that reliably crashes (the default SEED now rolls a UFO that escapes).
    const campaign = createCampaign({ lat: 2, lon: 14.2, region: "Africa" }, 98);
    const detected = advanceGeoscape(campaign, 29);
    const damaged = interceptUfo(detected);
    const afterCrashExpires = advanceGeoscape(damaged, CRASH_SITE_LIFETIME_HOURS);
    const repairingWithContact = advanceGeoscape(afterCrashExpires, 29);
    const lost = { ...campaign, strategic: { ...campaign.strategic, status: "lost" as const } };

    expect(geoscapeTimeAction(campaign)).toEqual({
      label: `Scan ${GEOSCAPE_SCAN_HOURS}h`,
      hours: GEOSCAPE_SCAN_HOURS,
      disabled: false,
    });
    expect(geoscapeTimeAction(detected)).toEqual({
      label: `Track ${GEOSCAPE_SCAN_HOURS}h`,
      hours: GEOSCAPE_SCAN_HOURS,
      disabled: false,
    });
    expect(geoscapeTimeAction(damaged)).toEqual({
      label: `Hold ${GEOSCAPE_SCAN_HOURS}h`,
      hours: GEOSCAPE_SCAN_HOURS,
      disabled: false,
    });
    expect(repairingWithContact.ufoContact?.status).toBe("tracked");
    expect(isInterceptorReady(repairingWithContact)).toBe(true);
    expect(geoscapeTimeAction(repairingWithContact)).toEqual({
      label: `Track ${GEOSCAPE_SCAN_HOURS}h`,
      hours: GEOSCAPE_SCAN_HOURS,
      disabled: false,
    });
    expect(geoscapeTimeAction(lost).disabled).toBe(true);
  });
});

describe("geoscape UFO detect time policy", () => {
  it("detects a new UFO contact and drops fast-forward to 1× (does not force-pause)", () => {
    const base = createCampaign({ lat: 2, lon: 14.2, region: "Africa" }, 98);
    const prev = snapshotGeoscapeEvent(base);
    const contact: UfoContact = {
      id: "UFO-DETECT-TEST",
      status: "tracked",
      missionType: "crashSite",
      lat: 4,
      lon: 22,
      region: "Africa",
      detectedAtHour: 10,
      expiresAtHour: 40,
      missionSeed: 1,
      strength: 1,
    };
    const withContact: CampaignState = { ...base, ufoContact: contact };
    const info = detectGeoscapeEvent(prev, withContact);
    expect(info).toMatchObject({ alertKind: "ufoDetected" });
    expect(geoscapeShouldForcePause(info!)).toBe(false);
    expect(geoscapeShouldDropToRealtime(info!)).toBe(true);
  });

  it("force-pauses on a landed UFO, not on an interception report", () => {
    expect(
      geoscapeShouldForcePause({
        kind: "info",
        text: "UFO landed",
        alertKind: "ufoLanded",
      }),
    ).toBe(true);
    expect(
      geoscapeShouldForcePause({
        kind: "info",
        text: "Interception report filed",
        alertKind: "interceptionReport",
      }),
    ).toBe(false);
    expect(
      geoscapeShouldDropToRealtime({
        kind: "info",
        text: "Interception report filed",
        alertKind: "interceptionReport",
      }),
    ).toBe(false);
  });
});
