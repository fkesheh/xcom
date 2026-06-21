import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { canLaunchInterceptor, createUfoContact, interceptUfo } from "../src/campaign/geoscape";
import {
  chooseInterceptor,
  createCampaign,
  loadCampaign,
  readyInterceptors,
  repairFleet,
  saveCampaign,
  STARTING_FLEET,
  transportCraft,
} from "../src/campaign/storage";
import type { CampaignState } from "../src/campaign/types";

const BASE = { lat: 2, lon: 14.2, region: "Africa" } as const;
const SEED = 12345;

/** Builds a campaign with a tracked crash-site UFO at hour 18, ready for interception. */
function withTrackedContact(): CampaignState {
  const campaign = createCampaign(BASE, SEED);
  const contact = createUfoContact(campaign, 18, "crashSite");
  return {
    ...campaign,
    clock: { ...campaign.clock, elapsedHours: 18 },
    ufoContact: contact,
  };
}

describe("starting fleet", () => {
  it("begins with two interceptors and one Skyranger transport", () => {
    const campaign = createCampaign(BASE, SEED);

    expect(campaign.fleet).toHaveLength(3);
    expect(campaign.fleet!.map((craft) => craft.id).sort()).toEqual(["int-1", "int-2", "sky-1"]);
    expect(campaign.fleet!.filter((craft) => craft.kind === "interceptor")).toHaveLength(2);
    const transport = campaign.fleet!.filter((craft) => craft.kind === "transport");
    expect(transport).toHaveLength(1);
    expect(transport[0]!.name).toBe("Skyranger");
    // Every starting craft is undamaged and has flown no sorties.
    expect(campaign.fleet!.every((craft) => craft.damage === 0 && craft.sorties === 0)).toBe(true);
    // STARTING_FLEET is the canonical frozen complement.
    expect(STARTING_FLEET.map((craft) => craft.id)).toEqual(["int-1", "int-2", "sky-1"]);
    // The legacy interceptor field stays populated and consistent for migration/UI.
    expect(campaign.interceptor).toEqual({ damage: 0, sorties: 0 });
  });

  it("exposes two ready interceptors and a transport from a fresh campaign", () => {
    const campaign = createCampaign(BASE, SEED);

    expect(readyInterceptors(campaign)).toHaveLength(2);
    expect(readyInterceptors(campaign).map((craft) => craft.id)).toEqual(["int-1", "int-2"]);
    const chosen = chooseInterceptor(campaign);
    expect(chosen).toBeDefined();
    expect(chosen!.id).toBe("int-1");
    expect(chosen!.kind).toBe("interceptor");
    expect(transportCraft(campaign)?.id).toBe("sky-1");
    expect(transportCraft(campaign)?.kind).toBe("transport");
  });
});

describe("interception routes through the fleet", () => {
  it("damages only the engaging interceptor; the standby interceptor and transport are unaffected", () => {
    const detected = withTrackedContact();
    expect(canLaunchInterceptor(detected)).toBe(true);

    const result = interceptUfo(detected);

    // The engaging craft (int-1, first ready interceptor) took the hit.
    const engaged = result.fleet!.find((craft) => craft.id === "int-1");
    expect(engaged?.damage).toBeGreaterThan(0);
    expect(engaged?.sorties).toBe(1);
    expect(engaged?.repairedAtHour).toBeGreaterThan(result.clock.elapsedHours);

    // The standby interceptor is untouched.
    const standby = result.fleet!.find((craft) => craft.id === "int-2");
    expect(standby?.damage).toBe(0);
    expect(standby?.sorties).toBe(0);
    expect(standby?.repairedAtHour).toBeUndefined();

    // The transport never participates in air-to-air interception.
    const transport = result.fleet!.find((craft) => craft.id === "sky-1");
    expect(transport?.damage).toBe(0);
    expect(transport?.sorties).toBe(0);
    expect(transport?.repairedAtHour).toBeUndefined();

    // The legacy interceptor field mirrors the engaging craft's damage.
    expect(result.interceptor.damage).toBe(engaged!.damage);
    expect(result.interceptor.sorties).toBe(1);
  });

  it("falls back to the standby interceptor when the primary is repairing", () => {
    // Ground int-1 with pending repair (no sortie recorded); int-2 should engage next.
    const detected = withTrackedContact();
    const repairing: CampaignState = {
      ...detected,
      fleet: detected.fleet!.map((craft) =>
        craft.id === "int-1"
          ? { ...craft, damage: 50, repairedAtHour: detected.clock.elapsedHours + 40 }
          : craft,
      ),
    };
    expect(chooseInterceptor(repairing)?.id).toBe("int-2");
    expect(canLaunchInterceptor(repairing)).toBe(true);

    const result = interceptUfo(repairing);

    // int-2 engaged this time; int-1 keeps its earlier damage until its own repair completes.
    const int2 = result.fleet!.find((craft) => craft.id === "int-2");
    expect(int2?.sorties).toBe(1);
    expect(int2?.damage).toBeGreaterThan(0);
    const int1 = result.fleet!.find((craft) => craft.id === "int-1");
    expect(int1?.damage).toBe(50);
    expect(int1?.sorties).toBe(0);
  });
});

describe("fleet repair over time", () => {
  it("clears a damaged interceptor's damage once its repairedAtHour arrives, and not before", () => {
    const detected = withTrackedContact();
    const damaged = interceptUfo(detected);
    const engaged = damaged.fleet!.find((craft) => craft.id === "int-1")!;
    expect(engaged.repairedAtHour).toBeDefined();
    const repairDeadline = engaged.repairedAtHour!;

    // One hour before the repair completes: still damaged.
    const before = repairFleet(damaged, repairDeadline - 1);
    expect(before.fleet!.find((craft) => craft.id === "int-1")?.damage).toBe(engaged.damage);
    expect(before.fleet!.find((craft) => craft.id === "int-1")?.repairedAtHour).toBe(repairDeadline);

    // At the repair deadline: damage cleared, sorties preserved, repair window closed.
    const repaired = repairFleet(damaged, repairDeadline);
    const repairedInt1 = repaired.fleet!.find((craft) => craft.id === "int-1");
    expect(repairedInt1?.damage).toBe(0);
    expect(repairedInt1?.sorties).toBe(1);
    expect(repairedInt1?.repairedAtHour).toBeUndefined();

    // The standby interceptor and transport are unaffected by the repair pass.
    expect(repaired.fleet!.find((craft) => craft.id === "int-2")?.sorties).toBe(0);
    expect(repaired.fleet!.find((craft) => craft.id === "sky-1")?.damage).toBe(0);

    // The legacy interceptor field mirrors the repaired state.
    expect(repaired.interceptor).toEqual({ damage: 0, sorties: 1 });
  });
});

describe("old save migration", () => {
  // The vitest environment is "node" (no localStorage); install a minimal shim for this suite.
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

  beforeEach(() => {
    installLocalStorageShim();
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it("migrates a pre-fleet single-interceptor save into the 3-craft complement", () => {
    // Simulate an old save: no fleet, just the legacy interceptor with history.
    const legacy = createCampaign(BASE, SEED);
    const oldSave: CampaignState = {
      ...legacy,
      fleet: undefined,
      interceptor: { damage: 40, sorties: 2, repairedAtHour: 999 },
    };

    saveCampaign(oldSave);
    const loaded = loadCampaign();

    expect(loaded).not.toBeNull();
    expect(loaded!.fleet).toHaveLength(3);

    // The legacy interceptor becomes int-1, carrying its damage/sorties/repair.
    const int1 = loaded!.fleet!.find((craft) => craft.id === "int-1");
    expect(int1?.kind).toBe("interceptor");
    expect(int1?.name).toBe("Raptor-1");
    expect(int1?.damage).toBe(40);
    expect(int1?.sorties).toBe(2);
    expect(int1?.repairedAtHour).toBe(999);

    // A fresh second interceptor and the Skyranger transport are added.
    const int2 = loaded!.fleet!.find((craft) => craft.id === "int-2");
    expect(int2?.damage).toBe(0);
    expect(int2?.sorties).toBe(0);
    expect(transportCraft(loaded!)?.id).toBe("sky-1");
    expect(transportCraft(loaded!)?.name).toBe("Skyranger");
  });

  it("round-trips a modern 3-craft fleet save without migration", () => {
    const modern = createCampaign(BASE, SEED);
    saveCampaign(modern);
    const loaded = loadCampaign();

    expect(loaded).not.toBeNull();
    expect(loaded!.fleet!.map((craft) => craft.id).sort()).toEqual(["int-1", "int-2", "sky-1"]);
    expect(loaded!.fleet!.every((craft) => craft.damage === 0)).toBe(true);
  });
});
