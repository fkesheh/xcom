import { describe, expect, it } from "vitest";

import type { CampaignState, CampaignWeaponId } from "../src/campaign/types";
import {
  canPurchaseWeapon,
  completeResearch,
  createCampaign,
  difficultyConfig,
  DIFFICULTY_CONFIGS,
  MARKET_CONFIG,
  purchaseWeapon,
  restockMarket,
  STARTING_MARKET,
} from "../src/campaign/storage";

const BASE = { lat: 2, lon: 14.2, region: "Africa" };
const SEED = 12345;
const WEAPON_IDS = ["rifle", "pistol", "plasma"] as const satisfies readonly CampaignWeaponId[];

function withOverrides(overrides: Partial<CampaignState> = {}): CampaignState {
  return { ...createCampaign(BASE, SEED), ...overrides };
}

describe("difficulty presets", () => {
  it.each([
    ["rookie", DIFFICULTY_CONFIGS.rookie],
    ["veteran", DIFFICULTY_CONFIGS.veteran],
    ["commander", DIFFICULTY_CONFIGS.commander],
  ] as const)("difficultyConfig returns the %s preset reference", (level, config) => {
    const campaign = createCampaign(BASE, SEED, level);
    expect(difficultyConfig(campaign)).toBe(config);
  });

  it("veteran (the default) reproduces the current starting numbers exactly", () => {
    const campaign = createCampaign(BASE, SEED);

    expect(campaign.strategic).toEqual({ status: "active", threat: 25, funding: 600, score: 0 });
    expect(campaign.strategic.difficulty).toBeUndefined();
    expect(campaign.resources).toEqual({ credits: 650, alloys: 0, elerium: 0, alienData: 0 });
    expect(difficultyConfig(campaign)).toBe(DIFFICULTY_CONFIGS.veteran);
  });

  it("rookie eases the opening and commander tightens it", () => {
    const rookie = createCampaign(BASE, SEED, "rookie");
    const veteran = createCampaign(BASE, SEED, "veteran");
    const commander = createCampaign(BASE, SEED, "commander");

    expect(rookie.strategic.difficulty).toBe("rookie");
    expect(commander.strategic.difficulty).toBe("commander");

    expect(rookie.strategic.threat).toBeLessThan(veteran.strategic.threat);
    expect(rookie.strategic.funding).toBeGreaterThan(veteran.strategic.funding);
    expect(rookie.resources.credits).toBeGreaterThan(veteran.resources.credits);

    expect(commander.strategic.threat).toBeGreaterThan(veteran.strategic.threat);
    expect(commander.strategic.funding).toBeLessThan(veteran.strategic.funding);
    expect(commander.resources.credits).toBeLessThan(veteran.resources.credits);
  });

  it("derives the same identity for a fixed seed regardless of difficulty", () => {
    const rookie = createCampaign(BASE, SEED, "rookie");
    const commander = createCampaign(BASE, SEED, "commander");

    expect(rookie.id).toBe(commander.id);
    expect(rookie.seed).toBe(commander.seed);
  });
});

describe("equipment market", () => {
  it("seeds the market at full stock for every weapon", () => {
    const campaign = createCampaign(BASE, SEED);

    expect(campaign.market).toEqual(STARTING_MARKET);
    for (const id of WEAPON_IDS) {
      expect(campaign.market?.stock[id]).toBe(MARKET_CONFIG[id].maxStock);
      expect(MARKET_CONFIG[id].restockHours).toBeGreaterThan(0);
    }
  });

  it.each(["rifle", "pistol"] as const)("canPurchaseWeapon requires credits and stock for %s", (weaponId) => {
    const price = MARKET_CONFIG[weaponId].price;
    const funded = withOverrides({
      resources: { credits: price, alloys: 0, elerium: 0, alienData: 0 },
    });
    expect(canPurchaseWeapon(funded, weaponId)).toEqual({ ok: true });

    const broke = withOverrides({
      resources: { credits: price - 1, alloys: 0, elerium: 0, alienData: 0 },
    });
    const check = canPurchaseWeapon(broke, weaponId);
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/credits/i);
  });

  it("plasma is locked behind the plasmaWeapons research project", () => {
    const price = MARKET_CONFIG.plasma.price;
    // Fully funded but no plasmaWeapons research: plasma is in council stock but
    // not cleared for sale, so the purchase is blocked at the availability gate.
    const funded = withOverrides({
      resources: { credits: price, alloys: 0, elerium: 0, alienData: 0 },
    });
    expect(canPurchaseWeapon(funded, "plasma").ok).toBe(false);

    // Once plasmaWeapons completes (resources topped up to afford its cost), the
    // gate opens and a funded commander can buy the plasma caster.
    const unlocked = completeResearch(
      withOverrides({
        resources: { credits: 5000, alloys: 50, elerium: 50, alienData: 50 },
      }),
      "plasmaWeapons",
    );
    expect(canPurchaseWeapon(unlocked, "plasma")).toEqual({ ok: true });
  });

  it("blocks purchase when stock is empty even with ample credits", () => {
    const funded = withOverrides({
      resources: { credits: 5000, alloys: 0, elerium: 0, alienData: 0 },
      market: { stock: { rifle: 0, pistol: 0, plasma: 0 }, restockTimerHours: {} },
    });
    const check = canPurchaseWeapon(funded, "rifle");

    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/stock/i);
    expect(purchaseWeapon(funded, "rifle")).toBe(funded);
  });

  it("purchaseWeapon debits credits, decrements stock, and arms the squad", () => {
    const funded = withOverrides({
      resources: { credits: 2000, alloys: 0, elerium: 0, alienData: 0 },
    });
    const rifleBefore = funded.armory.weapons.rifle;
    const stockBefore = funded.market!.stock.rifle!;

    const bought = purchaseWeapon(funded, "rifle");

    expect(bought).not.toBe(funded);
    expect(bought.resources.credits).toBe(2000 - MARKET_CONFIG.rifle.price);
    expect(bought.armory.weapons.rifle).toBe(rifleBefore + 1);
    expect(bought.market?.stock.rifle).toBe(stockBefore - 1);
  });

  it("does not mutate the input campaign", () => {
    const funded = withOverrides({
      resources: { credits: 2000, alloys: 0, elerium: 0, alienData: 0 },
    });
    const creditsBefore = funded.resources.credits;
    const rifleBefore = funded.armory.weapons.rifle;
    const stockBefore = funded.market!.stock.rifle!;

    purchaseWeapon(funded, "rifle");

    expect(funded.resources.credits).toBe(creditsBefore);
    expect(funded.armory.weapons.rifle).toBe(rifleBefore);
    expect(funded.market!.stock.rifle).toBe(stockBefore);
  });

  it("restockMarket replenishes stock toward max over time and then stops", () => {
    const restockHours = MARKET_CONFIG.rifle.restockHours;
    const sold = withOverrides({
      resources: { credits: 5000, alloys: 0, elerium: 0, alienData: 0 },
      market: {
        stock: { rifle: 3, pistol: MARKET_CONFIG.pistol.maxStock, plasma: MARKET_CONFIG.plasma.maxStock },
        restockTimerHours: {},
      },
    });

    const partial = restockMarket(sold, restockHours - 1);
    expect(partial.market?.stock.rifle).toBe(3);
    expect(partial.market?.restockTimerHours.rifle).toBe(restockHours - 1);

    const oneRestocked = restockMarket(sold, restockHours);
    expect(oneRestocked.market?.stock.rifle).toBe(4);
    expect(oneRestocked.market?.restockTimerHours.rifle).toBe(0);

    const fullyRestocked = restockMarket(sold, restockHours * 10);
    expect(fullyRestocked.market?.stock.rifle).toBe(MARKET_CONFIG.rifle.maxStock);
    expect(fullyRestocked.market?.restockTimerHours.rifle).toBe(0);
    // Weapons already at max are untouched and do not bank time.
    expect(fullyRestocked.market?.stock.pistol).toBe(MARKET_CONFIG.pistol.maxStock);
    expect(fullyRestocked.market?.restockTimerHours.pistol).toBe(0);
  });

  it("does not bank restock time once stock is full", () => {
    const full = withOverrides({ market: cloneFullMarket() });
    const rested = restockMarket(full, MARKET_CONFIG.rifle.restockHours);

    expect(rested.market?.stock.rifle).toBe(MARKET_CONFIG.rifle.maxStock);
    expect(rested.market?.restockTimerHours.rifle).toBe(0);
  });

  it("leaves the campaign unchanged when zero hours elapse", () => {
    const campaign = createCampaign(BASE, SEED);
    expect(restockMarket(campaign, 0)).toBe(campaign);
  });
});

function cloneFullMarket(): CampaignState["market"] {
  return {
    stock: {
      rifle: MARKET_CONFIG.rifle.maxStock,
      pistol: MARKET_CONFIG.pistol.maxStock,
      plasma: MARKET_CONFIG.plasma.maxStock,
    },
    restockTimerHours: {},
  };
}
