import { describe, expect, it } from "vitest";

import { advanceGeoscape } from "../src/campaign/geoscape";
import {
  createCampaign,
  dropDeploymentFlights,
  launchDeploymentFlight,
} from "../src/campaign/storage";
import type { ActiveFlight, CampaignState, UfoContact } from "../src/campaign/types";

const BASE = { lat: 48.2, lon: 14.6, region: "Europe" } as const;
const SEED = 4242;

function contactAt(lat: number, lon: number): UfoContact {
  return {
    id: "ufo-1",
    status: "crashed",
    lat,
    lon,
    region: "Europe",
    detectedAtHour: 0,
    expiresAtHour: 200,
    missionSeed: 1,
    strength: 3,
  };
}

function campaignWithContact(): CampaignState {
  const fresh = createCampaign(BASE, SEED);
  return { ...fresh, ufoContact: contactAt(20, 30) };
}

describe("launchDeploymentFlight", () => {
  it("appends a non-blocking deployment flight from base to the contact site", () => {
    const campaign = campaignWithContact();
    const next = launchDeploymentFlight(campaign, "ufo-1");
    const flights = next.activeFlights ?? [];
    expect(flights).toHaveLength(1);
    const flight = flights[0]!;
    expect(flight.purpose).toBe("deployment");
    expect(flight.deployContactId).toBe("ufo-1");
    expect(flight.arrived).toBe(false);
    expect(flight.kind).toBe("transport");
    expect(flight.progress).toBe(0);
    expect(flight.fromLat).toBe(BASE.lat);
    expect(flight.fromLon).toBe(BASE.lon);
    expect(flight.toLat).toBe(20);
    expect(flight.toLon).toBe(30);
    // Uses the Skyranger transport's craft id + cruise speed.
    expect(flight.craftId).toBe("sky-1");
    expect(flight.speedDegPerHour).toBeGreaterThan(0);
  });

  it("uses the transport's own cruise speed", () => {
    const campaign = campaignWithContact();
    const transportSpeed = campaign.fleet?.find((c) => c.kind === "transport")?.speedDegPerHour;
    const next = launchDeploymentFlight(campaign, "ufo-1");
    expect(next.activeFlights?.[0]?.speedDegPerHour).toBe(transportSpeed);
  });

  it("is a no-op when the contact id does not match the live contact", () => {
    const campaign = campaignWithContact();
    expect(launchDeploymentFlight(campaign, "nope")).toBe(campaign);
  });

  it("is a no-op when a deployment for the same contact is already in flight", () => {
    const campaign = campaignWithContact();
    const once = launchDeploymentFlight(campaign, "ufo-1");
    const twice = launchDeploymentFlight(once, "ufo-1");
    expect(twice).toBe(once);
    expect(twice.activeFlights).toHaveLength(1);
  });

  it("preserves existing patrol flights when appending the deployment", () => {
    const patrol: ActiveFlight = {
      id: "patrol:int-1:ufo-9",
      craftId: "int-1",
      kind: "interceptor",
      fromLat: 0,
      fromLon: 0,
      toLat: 10,
      toLon: 10,
      progress: 0.3,
      speedDegPerHour: 0.9,
      startedAtHour: 0,
    };
    const campaign = { ...campaignWithContact(), activeFlights: [patrol] };
    const next = launchDeploymentFlight(campaign, "ufo-1");
    expect(next.activeFlights).toHaveLength(2);
    expect(next.activeFlights?.some((f) => f.id === "patrol:int-1:ufo-9")).toBe(true);
  });
});

describe("deployment flight persists on arrival (non-blocking model)", () => {
  it("stays on the globe at progress 1 after advanceGeoscape (not retired like a patrol)", () => {
    const fresh = createCampaign(BASE, SEED);
    // Crashed contact a short hop from the base (~1 deg) so the Skyranger arrives fast
    // and no interceptor patrol auto-launches (only tracked UFOs scramble one).
    const contact: UfoContact = {
      ...contactAt(49.2, 15.6),
      status: "crashed",
      expiresAtHour: 9999,
    };
    const launched = launchDeploymentFlight({ ...fresh, ufoContact: contact }, "ufo-1");
    expect(launched.activeFlights).toHaveLength(1);

    // Advance well past the arrival time; the deployment flight must remain, clamped
    // at progress 1 — the model no longer deletes it the way it retires a patrol.
    const advanced = advanceGeoscape(launched, 12);
    const deploy = (advanced.activeFlights ?? []).find((f) => f.purpose === "deployment");
    expect(deploy).toBeDefined();
    expect(deploy!.progress).toBe(1);
    expect(deploy!.deployContactId).toBe("ufo-1");
  });
});

describe("deployment flight cleanup when its contact expires (softlock guard)", () => {
  it("drops an in-transit deployment flight once its target contact expires", () => {
    const fresh = createCampaign(BASE, SEED);
    // A crash site far from base with a SHORT life: the Skyranger cannot arrive before
    // the contact expires, so the flight must be cleaned up (else it strands forever and
    // suppresses every future ground-mission launch — a save-persisted softlock).
    const contact: UfoContact = {
      ...contactAt(-40, 160),
      status: "crashed",
      expiresAtHour: 3,
    };
    const launched = launchDeploymentFlight({ ...fresh, ufoContact: contact }, "ufo-1");
    expect(launched.activeFlights).toHaveLength(1);

    const advanced = advanceGeoscape(launched, 6);
    // Contact has expired…
    expect(advanced.ufoContact?.id).not.toBe("ufo-1");
    // …and the deployment flight targeting it is gone, so no `flightInProgress`
    // suppression can block the next contact's launch.
    const deploy = (advanced.activeFlights ?? []).find((f) => f.purpose === "deployment");
    expect(deploy).toBeUndefined();
  });

  it("drops an on-station (arrived) deployment flight if its contact then expires", () => {
    const fresh = createCampaign(BASE, SEED);
    // Close crash site so the Skyranger arrives (progress 1) before expiry, then let the
    // contact lapse: the on-station flight (and its dead DEPLOY chip) must be retired.
    const contact: UfoContact = {
      ...contactAt(49.2, 15.6),
      status: "crashed",
      expiresAtHour: 30,
    };
    const launched = launchDeploymentFlight({ ...fresh, ufoContact: contact }, "ufo-1");

    const arrived = advanceGeoscape(launched, 12);
    expect((arrived.activeFlights ?? []).find((f) => f.purpose === "deployment")?.progress).toBe(1);

    // Now push time past the contact's expiry.
    const afterExpiry = advanceGeoscape(arrived, 40);
    expect(afterExpiry.ufoContact?.id).not.toBe("ufo-1");
    expect((afterExpiry.activeFlights ?? []).find((f) => f.purpose === "deployment")).toBeUndefined();
  });
});

describe("dropDeploymentFlights", () => {
  const deployment: ActiveFlight = {
    id: "deploy:ufo-1",
    craftId: "sky-1",
    kind: "transport",
    fromLat: 0,
    fromLon: 0,
    toLat: 10,
    toLon: 10,
    progress: 1,
    speedDegPerHour: 0.7,
    startedAtHour: 0,
    purpose: "deployment",
    deployContactId: "ufo-1",
    arrived: true,
  };
  const patrol: ActiveFlight = {
    id: "patrol:int-1:ufo-9",
    craftId: "int-1",
    kind: "interceptor",
    fromLat: 0,
    fromLon: 0,
    toLat: 10,
    toLon: 10,
    progress: 0.3,
    speedDegPerHour: 0.9,
    startedAtHour: 0,
  };

  it("removes deployment flights but keeps interceptor patrols", () => {
    const kept = dropDeploymentFlights([deployment, patrol]);
    expect(kept).toEqual([patrol]);
  });

  it("returns undefined when only deployment flights remain (fresh 'no flights' shape)", () => {
    expect(dropDeploymentFlights([deployment])).toBeUndefined();
  });

  it("returns undefined for an empty or absent roster", () => {
    expect(dropDeploymentFlights([])).toBeUndefined();
    expect(dropDeploymentFlights(undefined)).toBeUndefined();
  });
});
