import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BASE_MARKET_WEAPONS,
  canPurchaseWeapon,
  completeResearch,
  createCampaign,
  hasResearch,
  isWeaponAvailable,
  loadCampaign,
  MARKET_CONFIG,
  purchaseWeapon,
  RESEARCH_PROJECTS,
  restockMarket,
  saveCampaign,
  STARTING_MARKET,
  weaponMarketEntry,
} from "../src/campaign/storage";
import type { CampaignState, ResearchId } from "../src/campaign/types";

const BASE = { lat: 2, lon: 14.2, region: "Africa" } as const;
const SEED = 12345;

/** Top up resources so every research project is affordable outright. */
function stock(campaign: CampaignState, credits = 5000): CampaignState {
  return {
    ...campaign,
    resources: { credits, alloys: 500, elerium: 500, alienData: 500 },
  };
}

function project(id: ResearchId) {
  const node = RESEARCH_PROJECTS.find((entry) => entry.id === id);
  if (!node) throw new Error(`unknown research id ${id}`);
  return node;
}

/** Minimal localStorage shim so the node test env can exercise save -> load. */
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
  Object.defineProperty(globalThis, "localStorage", {
    value: shim,
    configurable: true,
    writable: true,
  });
}

describe("research project unlock declarations", () => {
  it("every gear project declares at least one weapon or item unlock", () => {
    for (const node of RESEARCH_PROJECTS) {
      // Interrogation projects grant intel / HQ reveal / final-assault unlock,
      // and craft-tech projects gate a buildable interceptor rather than squad
      // gear, so both are exempt from the weapon/item unlock rule.
      if (node.consumesCaptive || node.unlocksManufacturing) continue;
      const unlocks = node.unlocks;
      expect(unlocks, `project ${node.id} should declare unlocks`).toBeDefined();
      const total = (unlocks?.weapons?.length ?? 0) + (unlocks?.items?.length ?? 0);
      expect(total).toBeGreaterThan(0);
    }
  });

  it("plasmaWeapons unlocks the plasma weapon, heavyPlasma unlocks the cannon", () => {
    expect(project("plasmaWeapons").unlocks?.weapons).toContain("plasma");
    expect(project("heavyPlasma").unlocks?.weapons).toContain("cannon");
  });

  it("improvedMedikit and alienBiotech unlock medkit stock", () => {
    expect(project("improvedMedikit").unlocks?.items).toContain("medkit");
    expect(project("alienBiotech").unlocks?.items).toContain("medkit");
  });

  it("every declared weapon unlock has a configured market entry (priceable + restockable)", () => {
    const weaponIds = new Set<string>();
    for (const node of RESEARCH_PROJECTS) {
      for (const weapon of node.unlocks?.weapons ?? []) {
        weaponIds.add(weapon);
      }
    }
    for (const weapon of weaponIds) {
      const entry = weaponMarketEntry(weapon);
      expect(entry, `weapon ${weapon} should have a market entry`).toBeDefined();
      expect(entry!.price).toBeGreaterThan(0);
      expect(entry!.maxStock).toBeGreaterThan(0);
      expect(entry!.restockHours).toBeGreaterThan(0);
    }
  });
});

describe("plasmaWeapons -> plasma market unlock", () => {
  it("plasma is NOT purchasable on a fresh campaign even with ample credits", () => {
    const funded = stock(createCampaign(BASE, SEED));
    expect(isWeaponAvailable(funded, "plasma")).toBe(false);
    const check = canPurchaseWeapon(funded, "plasma");
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/available/i);
  });

  it("completing plasmaWeapons makes plasma purchasable", () => {
    const funded = stock(createCampaign(BASE, SEED));
    expect(hasResearch(funded, "plasmaWeapons")).toBe(false);

    const unlocked = completeResearch(funded, "plasmaWeapons");
    expect(hasResearch(unlocked, "plasmaWeapons")).toBe(true);
    expect(isWeaponAvailable(unlocked, "plasma")).toBe(true);
    expect(canPurchaseWeapon(unlocked, "plasma")).toEqual({ ok: true });
  });

  it("plasmaWeapons still grants one prototype plasma caster to the armory", () => {
    const campaign = stock(createCampaign(BASE, SEED));
    expect(campaign.armory.weapons.plasma).toBe(0);
    const unlocked = completeResearch(campaign, "plasmaWeapons");
    expect(unlocked.armory.weapons.plasma).toBe(1);
  });

  it("before research, purchaseWeapon is a no-op; after, it debits and arms", () => {
    const funded = stock(createCampaign(BASE, SEED));

    // Locked: purchase is refused and the campaign reference is unchanged.
    const rejected = purchaseWeapon(funded, "plasma");
    expect(rejected).toBe(funded);

    const unlocked = completeResearch(funded, "plasmaWeapons");
    const creditsBefore = unlocked.resources.credits;
    const stockBefore = unlocked.market!.stock.plasma!;
    const armoryBefore = unlocked.armory.weapons.plasma;

    const bought = purchaseWeapon(unlocked, "plasma");
    expect(bought.resources.credits).toBe(creditsBefore - MARKET_CONFIG.plasma.price);
    expect(bought.market!.stock.plasma).toBe(stockBefore - 1);
    expect(bought.armory.weapons.plasma).toBe(armoryBefore + 1);
  });

  it("re-completing an already-finished project is a no-op", () => {
    const unlocked = completeResearch(stock(createCampaign(BASE, SEED)), "plasmaWeapons");
    expect(completeResearch(unlocked, "plasmaWeapons")).toBe(unlocked);
  });
});

describe("heavyPlasma -> cannon market entry", () => {
  it("cannon is unavailable and absent from the market until heavyPlasma completes", () => {
    const funded = stock(createCampaign(BASE, SEED));
    expect(isWeaponAvailable(funded, "cannon")).toBe(false);
    expect(funded.market?.stock.cannon).toBeUndefined();

    // plasmaWeapons alone does not open cannon (heavyPlasma is the gate).
    const withPlasma = completeResearch(funded, "plasmaWeapons");
    expect(isWeaponAvailable(withPlasma, "cannon")).toBe(false);
    expect(withPlasma.market?.stock.cannon).toBeUndefined();
  });

  it("completing heavyPlasma seeds cannon in the market at full capacity", () => {
    const withPlasma = completeResearch(stock(createCampaign(BASE, SEED)), "plasmaWeapons");
    const withHeavy = completeResearch(withPlasma, "heavyPlasma");

    const entry = weaponMarketEntry("cannon")!;
    expect(isWeaponAvailable(withHeavy, "cannon")).toBe(true);
    expect(withHeavy.market?.stock.cannon).toBe(entry.maxStock);
    expect(entry).toEqual({ price: 1800, maxStock: 4, restockHours: 60 });
  });

  it("cannon is purchasable end-to-end once heavyPlasma completes", () => {
    // Previously a phantom: stock was seeded but purchaseWeapon("cannon") could
    // neither typecheck nor find a price. It is now a real campaign weapon.
    const withHeavy = completeResearch(
      completeResearch(stock(createCampaign(BASE, SEED)), "plasmaWeapons"),
      "heavyPlasma",
    );

    // stock() funds 5000c; plasmaWeapons (200c) + heavyPlasma (260c) still leave
    // ample for the 1800c cannon.
    expect(canPurchaseWeapon(withHeavy, "cannon")).toEqual({ ok: true });

    const creditsBefore = withHeavy.resources.credits;
    const stockBefore = withHeavy.market!.stock.cannon!;
    const armoryBefore = withHeavy.armory.weapons.cannon;

    const bought = purchaseWeapon(withHeavy, "cannon");
    expect(bought).not.toBe(withHeavy);
    expect(bought.resources.credits).toBe(creditsBefore - MARKET_CONFIG.cannon.price);
    expect(bought.market!.stock.cannon).toBe(stockBefore - 1);
    expect(bought.armory.weapons.cannon).toBe(armoryBefore + 1);
  });

  it("cannon restocks toward max over time once seeded", () => {
    const withHeavy = completeResearch(
      completeResearch(stock(createCampaign(BASE, SEED)), "plasmaWeapons"),
      "heavyPlasma",
    );
    const entry = weaponMarketEntry("cannon")!;

    const bought = purchaseWeapon(withHeavy, "cannon");
    expect(bought.market!.stock.cannon).toBe(entry.maxStock - 1);

    const restocked = restockMarket(bought, entry.restockHours);
    expect(restocked.market!.stock.cannon).toBe(entry.maxStock);
  });
});

describe("item unlocks grant armory stock", () => {
  it("completing improvedMedikit boosts medkit stock (stacking on alienBiotech)", () => {
    const campaign = stock(createCampaign(BASE, SEED));
    const baseline = campaign.armory.items?.medkit ?? 0;

    const withBiotech = completeResearch(campaign, "alienBiotech");
    const afterBiotech = withBiotech.armory.items?.medkit ?? 0;
    expect(afterBiotech).toBe(baseline + 4);

    const withMedikit = completeResearch(withBiotech, "improvedMedikit");
    expect(withMedikit.armory.items?.medkit ?? 0).toBe(afterBiotech + 4);
  });

  it("completing alloyArmor boosts grenade stock", () => {
    const campaign = stock(createCampaign(BASE, SEED));
    const baseline = campaign.armory.items?.grenade ?? 0;
    const armored = completeResearch(campaign, "alloyArmor");
    expect(armored.armory.items?.grenade ?? 0).toBe(baseline + 4);
  });
});

describe("base weapons are always available", () => {
  it("rifle and pistol are purchasable on a fresh funded campaign", () => {
    expect(BASE_MARKET_WEAPONS).toEqual(["rifle", "pistol"]);
    const funded = stock(createCampaign(BASE, SEED));
    for (const id of BASE_MARKET_WEAPONS) {
      expect(isWeaponAvailable(funded, id)).toBe(true);
      expect(canPurchaseWeapon(funded, id)).toEqual({ ok: true });
    }
  });

  it("the starting market still carries plasma stock (clearance-gated, not absent)", () => {
    expect(STARTING_MARKET.stock.plasma).toBe(MARKET_CONFIG.plasma.maxStock);
  });
});

describe("save/load preserves research-unlocked market stock", () => {
  beforeEach(() => installLocalStorageShim());
  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).localStorage;
  });

  it("cannon stock and plasma availability survive a save -> load round trip", () => {
    const campaign = completeResearch(
      completeResearch(stock(createCampaign(BASE, SEED)), "plasmaWeapons"),
      "heavyPlasma",
    );
    expect(campaign.market?.stock.cannon).toBe(weaponMarketEntry("cannon")!.maxStock);

    saveCampaign(campaign);
    const reloaded = loadCampaign();
    expect(reloaded).not.toBeNull();
    expect(reloaded!.market?.stock.cannon).toBe(weaponMarketEntry("cannon")!.maxStock);
    expect(isWeaponAvailable(reloaded!, "plasma")).toBe(true);
    expect(isWeaponAvailable(reloaded!, "cannon")).toBe(true);
  });
});
