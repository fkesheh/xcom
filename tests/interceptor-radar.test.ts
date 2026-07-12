import { describe, expect, it } from "vitest";
import {
  activeFlightPosition,
  advanceGeoscape,
  createUfoContact,
  INTERCEPTOR_RADAR_RANGE_DEG,
} from "../src/campaign/geoscape";
import { createCampaign } from "../src/campaign/storage";
import type { ActiveFlight, BaseLocation } from "../src/campaign/types";

const BASE: BaseLocation = { lat: 0, lon: 0, region: "Africa" };

function greatCircleDistanceDeg(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
): number {
  const radians = Math.PI / 180;
  const aLat = from.lat * radians;
  const bLat = to.lat * radians;
  const deltaLon = (to.lon - from.lon) * radians;
  return Math.acos(
    Math.max(-1, Math.min(1, Math.sin(aLat) * Math.sin(bLat) + Math.cos(aLat) * Math.cos(bLat) * Math.cos(deltaLon))),
  ) / radians;
}

function patrol(): ActiveFlight {
  return {
    id: "patrol:int-1:area:0",
    craftId: "int-1",
    kind: "interceptor",
    fromLat: 0,
    fromLon: 0,
    toLat: 0,
    toLon: 20,
    progress: 0.5,
    speedDegPerHour: 36.2,
    startedAtHour: 0,
    purpose: "patrol",
    patrolMode: "area",
    patrolLat: 0,
    patrolLon: 20,
    stationed: true,
  };
}

describe("interceptor onboard radar", () => {
  it("tightens the contact interval while an interceptor is on area patrol", () => {
    const campaign = createCampaign(BASE, 42);
    const detected = advanceGeoscape({ ...campaign, activeFlights: [patrol()] }, 24);

    // Month zero multiplies intervals by 1.6: onboard radar lowers 18h to 15h,
    // producing a contact at 24h instead of the no-radar 29h interval.
    expect(detected.ufoContact).toBeDefined();
    expect(detected.ufoContact?.detectedAtHour).toBe(24);
  });

  it("places an onboard-radar detection inside the interceptor's sweep radius", () => {
    const flight = patrol();
    const campaign = { ...createCampaign(BASE, 42), activeFlights: [flight] };
    const contact = createUfoContact(campaign, 24, "crashSite");
    const craftPosition = activeFlightPosition(flight);

    expect(greatCircleDistanceDeg(craftPosition, contact)).toBeLessThanOrEqual(
      INTERCEPTOR_RADAR_RANGE_DEG + 0.15,
    );
  });

  it("reacquires an escaped UFO near a last-known-position search patrol", () => {
    const campaign = createCampaign(BASE, 42);
    const escaped = {
      ...createUfoContact(campaign, 0, "crashSite"),
      status: "escaped" as const,
      lat: 0,
      lon: 5,
      lastKnownLat: 0,
      lastKnownLon: 0,
      lostAtHour: 0,
      expiresAtHour: 8,
      heading: undefined,
    };
    const searchFlight: ActiveFlight = {
      ...patrol(),
      fromLon: -1,
      toLon: 1,
      progress: 0.5,
    };

    const reacquired = advanceGeoscape(
      { ...campaign, lostUfoContact: escaped, activeFlights: [searchFlight] },
      0,
    );

    expect(reacquired.ufoContact?.status).toBe("tracked");
    expect(reacquired.ufoContact?.lastKnownLat).toBeUndefined();
    expect(reacquired.lostUfoContact).toBeUndefined();
    expect(reacquired.activeFlights?.[0]).toMatchObject({
      craftId: "int-1",
      patrolMode: "contact",
      progress: 0,
    });
    expect(reacquired.activeFlights?.[0]?.id).toContain(escaped.id);
  });
});
