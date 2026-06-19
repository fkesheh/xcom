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
import { canSelectBaseSite, geoscapeTimeAction, regionFor, uvToLatLon } from "../../src/game/geoscape";

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
    const campaign = createCampaign({ lat: 2, lon: 14.2, region: "Africa" }, 12345);
    const detected = advanceGeoscape(campaign, 18);
    const damaged = interceptUfo(detected);
    const afterCrashExpires = advanceGeoscape(damaged, CRASH_SITE_LIFETIME_HOURS);
    const repairingWithContact = advanceGeoscape(afterCrashExpires, 18);
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
    expect(isInterceptorReady(repairingWithContact)).toBe(false);
    expect(geoscapeTimeAction(repairingWithContact)).toEqual({
      label: `Wait ${GEOSCAPE_SCAN_HOURS}h`,
      hours: GEOSCAPE_SCAN_HOURS,
      disabled: false,
    });
    expect(geoscapeTimeAction(lost).disabled).toBe(true);
  });
});
