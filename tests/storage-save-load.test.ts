import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  advanceGeoscape,
  canResolveInterception,
  createUfoContact,
  startInterceptionEncounter,
} from "../src/campaign/geoscape";
import { createCampaign, loadCampaign, saveCampaign } from "../src/campaign/storage";
import type { CampaignState } from "../src/campaign/types";

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

  it.each([
    ["tracked", "tracked" as const],
    ["landed", "landed" as const],
    ["engaging", "engaging" as const],
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
});
