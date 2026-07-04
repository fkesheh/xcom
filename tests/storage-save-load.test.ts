import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  advanceGeoscape,
  canResolveInterception,
  createUfoContact,
  startInterceptionEncounter,
} from "../src/campaign/geoscape";
import { createCampaign, launchDeploymentFlight, loadCampaign, saveCampaign } from "../src/campaign/storage";
import type { CampaignSoldier, CampaignState } from "../src/campaign/types";

const BASE = { lat: 2, lon: 14.2, region: "Africa" } as const;
const SEED = 12345;

/**
 * The vitest environment is "node", which has no localStorage, so loadCampaign is a
 * dead branch there. Install a minimal shim on globalThis to exercise the save/load
 * normalization path end to end.
 */
function installLocalStorageShim(): void {
  const store = new Map<string, string>();
  const shim: Storage = {
    get length(): number {
      return store.size;
    },
    clear(): void {
      store.clear();
    },
    getItem(key: string): string | null {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number): string | null {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string): void {
      store.delete(key);
    },
    setItem(key: string, value: string): void {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, "localStorage", { value: shim, configurable: true, writable: true });
}

function freshCampaign(): CampaignState {
  return createCampaign(BASE, SEED);
}

describe("campaign save/load normalization", () => {
  beforeEach(() => {
    installLocalStorageShim();
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  // "engaging" is intentionally NOT in this list: a contact is only ever "engaging"
  // alongside a live `interception`, so an engaging contact WITHOUT one is a corrupt
  // (stuck) state that loadCampaign reconciles to "tracked" — covered separately below.
  it.each([
    ["tracked", "tracked" as const],
    ["landed", "landed" as const],
    ["crashed", "crashed" as const],
  ])("preserves a %s ufoContact status across a save/load round-trip", (_label, status) => {
    const campaign = freshCampaign();
    const contact = { ...createUfoContact(campaign, 18, "terror"), status };
    const withContact = { ...campaign, ufoContact: contact };

    saveCampaign(withContact);
    const loaded = loadCampaign();

    expect(loaded).not.toBeNull();
    expect(loaded!.ufoContact).toBeDefined();
    expect(loaded!.ufoContact!.id).toBe(contact.id);
    expect(loaded!.ufoContact!.status).toBe(status);
    expect(loaded!.ufoContact!.missionType).toBe("terror");
  });

  it("round-trips a live engagement (engaging contact + matching interception) intact", () => {
    const campaign = freshCampaign();
    // A tracked crashSite contact at the base position drops straight into engagement.
    const contact = createUfoContact(campaign, 18, "crashSite");
    const staged: CampaignState = {
      ...campaign,
      clock: { ...campaign.clock, elapsedHours: 18 },
      ufoContact: { ...contact, lat: campaign.base.lat, lon: campaign.base.lon },
    };
    const engaged = startInterceptionEncounter(staged);
    expect(engaged.ufoContact!.status).toBe("engaging");
    expect(engaged.interception).toBeDefined();

    saveCampaign(engaged);
    const loaded = loadCampaign();

    expect(loaded!.ufoContact!.status).toBe("engaging");
    expect(loaded!.interception).toBeDefined();
    expect(loaded!.interception!.contactId).toBe(contact.id);
    expect(canResolveInterception(loaded!)).toBe(true);
  });

  it("reconciles a stuck engaging contact (no valid interception) back to tracked on load", () => {
    // Simulates a save captured mid-engagement on a previous build whose interception
    // wire schema no longer normalizes: the contact would otherwise sit inert at
    // "engaging", un-actable and un-re-engageable, until it expires and penalizes the
    // player. loadCampaign must reopen it to "tracked" and drop the orphan encounter.
    const campaign = freshCampaign();
    const contact = { ...createUfoContact(campaign, 18, "terror"), status: "engaging" as const };
    const staged: CampaignState = { ...campaign, ufoContact: contact, interception: undefined };

    saveCampaign(staged);
    const loaded = loadCampaign();

    expect(loaded!.ufoContact).toBeDefined();
    expect(loaded!.ufoContact!.status).toBe("tracked");
    expect(loaded!.interception).toBeUndefined();
    expect(canResolveInterception(loaded!)).toBe(false);
  });

  it("drops a stale escaped contact on load (matching applyInterceptionOutcome clearing ufoContact)", () => {
    const campaign = freshCampaign();
    const escaped = { ...createUfoContact(campaign, 18, "crashSite"), status: "escaped" as const };
    saveCampaign({ ...campaign, ufoContact: escaped });

    const loaded = loadCampaign();

    expect(loaded).not.toBeNull();
    expect(loaded!.ufoContact).toBeUndefined();
  });

  it("preserves a landed terror ground-assault contact so it can still seed its mission", () => {
    const campaign = freshCampaign();
    const landed = createUfoContact(campaign, 18, "terror");
    expect(landed.status).toBe("landed");
    saveCampaign({ ...campaign, ufoContact: landed });

    const loaded = loadCampaign();

    expect(loaded!.ufoContact!.status).toBe("landed");
    expect(loaded!.ufoContact!.missionType).toBe("terror");
    expect(loaded!.ufoContact!.missionSeed).toBe(landed.missionSeed);
  });

  it("preserves an in-progress engaging encounter so canResolveInterception stays true", () => {
    const detected = advanceGeoscape(freshCampaign(), 18);
    const started = startInterceptionEncounter(detected);
    expect(started.ufoContact?.status).toBe("engaging");
    expect(started.interception).toBeDefined();
    expect(canResolveInterception(started)).toBe(true);

    saveCampaign(started);
    const loaded = loadCampaign();

    // Regression: previously the engaging contact reloaded as "tracked" while the
    // InterceptionEncounter survived, freezing the encounter as unresolvable.
    expect(loaded!.ufoContact!.status).toBe("engaging");
    expect(loaded!.interception).toBeDefined();
    expect(loaded!.interception!.contactId).toBe(started.ufoContact!.id);
    expect(canResolveInterception(loaded!)).toBe(true);
  });

  it("preserves a soldier bio string across a save/load round-trip", () => {
    const campaign = freshCampaign();
    const first = campaign.soldiers[0]!;
    saveCampaign({
      ...campaign,
      soldiers: campaign.soldiers.map((s) =>
        s.id === first.id ? { ...s, bio: "Former paramedic, enlisted after the Berlin attack." } : s,
      ),
    });

    const loaded = loadCampaign();

    expect(loaded!.soldiers[0]!.bio).toBe("Former paramedic, enlisted after the Berlin attack.");
  });

  it("drops a malformed non-string bio on load (undefined OK)", () => {
    const campaign = freshCampaign();
    const first = campaign.soldiers[0]!;
    const malformed = campaign.soldiers.map((s) =>
      s.id === first.id ? { ...s, bio: { not: "a string" } } : s,
    ) as unknown as CampaignSoldier[];
    saveCampaign({ ...campaign, soldiers: malformed });

    const loaded = loadCampaign();

    expect(loaded!.soldiers[0]!.bio).toBeUndefined();
  });

  it("leaves a missing bio undefined for legacy saves", () => {
    const campaign = freshCampaign();
    saveCampaign({
      ...campaign,
      soldiers: campaign.soldiers.map(({ bio: _bio, ...rest }) => rest),
    });

    const loaded = loadCampaign();

    expect(loaded!.soldiers.every((s) => s.bio === undefined)).toBe(true);
  });

  it("preserves an in-flight deployment run (purpose/deployContactId/arrived) across save/load", () => {
    const campaign = freshCampaign();
    const contact = createUfoContact(campaign, 18, "crashSite");
    const launched = launchDeploymentFlight({ ...campaign, ufoContact: contact }, contact.id);
    // Simulate an ARRIVED deployment awaiting the player's DEPLOY click.
    const arrived = {
      ...launched,
      activeFlights: (launched.activeFlights ?? []).map((f) =>
        f.purpose === "deployment" ? { ...f, progress: 1, arrived: true } : f,
      ),
    };
    saveCampaign(arrived);

    const loaded = loadCampaign();
    const flight = loaded!.activeFlights?.find((f) => f.purpose === "deployment");
    expect(flight).toBeDefined();
    expect(flight!.deployContactId).toBe(contact.id);
    expect(flight!.arrived).toBe(true);
    expect(flight!.kind).toBe("transport");
  });

  it("normalizes a legacy patrol flight (no deployment fields) without adding them", () => {
    const campaign = freshCampaign();
    const legacyFlight = {
      id: "patrol:int-1:ufo-1",
      craftId: "int-1",
      kind: "interceptor" as const,
      fromLat: 0,
      fromLon: 0,
      toLat: 10,
      toLon: 10,
      progress: 0.4,
      speedDegPerHour: 0.9,
      startedAtHour: 0,
    };
    saveCampaign({ ...campaign, activeFlights: [legacyFlight] });

    const loaded = loadCampaign();
    const flight = loaded!.activeFlights?.[0];
    expect(flight).toBeDefined();
    expect(flight!.purpose).toBeUndefined();
    expect(flight!.deployContactId).toBeUndefined();
    expect(flight!.arrived).toBeUndefined();
  });
});
