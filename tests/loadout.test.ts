import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assignSoldierItem,
  availableItemCount,
  canAssignSoldierItem,
  createCampaign,
  deploymentItemIds,
  loadCampaign,
  recruitSoldier,
  saveCampaign,
  soldierItemIds,
  STARTING_ARMORY,
  unassignSoldierItem,
} from "../src/campaign/storage";
import type { CampaignState } from "../src/campaign/types";

const BASE = { lat: 2, lon: 14.2, region: "Africa" } as const;
const SEED = 12345;

/**
 * vitest runs in the "node" environment, which has no localStorage. loadCampaign is
 * a dead branch without it, so install a minimal shim to exercise save/load.
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

describe("soldier loadout items", () => {
  beforeEach(() => {
    installLocalStorageShim();
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it("stocks the starting armory with grenades, medkits, and smoke", () => {
    expect(STARTING_ARMORY.items).toEqual({ grenade: 8, medkit: 4, smoke: 4, stunRod: 4 });
    const campaign = freshCampaign();
    expect(campaign.armory.items).toEqual({ grenade: 8, medkit: 4, smoke: 4, stunRod: 4 });
  });

  it("reports the full starting stock as available before any assignment", () => {
    const campaign = freshCampaign();
    expect(availableItemCount(campaign, "grenade")).toBe(8);
    expect(availableItemCount(campaign, "medkit")).toBe(4);
    expect(availableItemCount(campaign, "smoke")).toBe(4);
  });

  it("assigns an item to a soldier and decrements armory stock without mutating the input", () => {
    const campaign = freshCampaign();
    const soldierId = campaign.soldiers[0]!.id;
    expect(canAssignSoldierItem(campaign, soldierId, "grenade")).toBe(true);

    const next = assignSoldierItem(campaign, soldierId, "grenade");

    expect(soldierItemIds(next, soldierId)).toEqual(["grenade"]);
    expect(availableItemCount(next, "grenade")).toBe(7);
    expect(next.armory.items?.grenade).toBe(7);
    expect(soldierItemIds(campaign, soldierId)).toEqual([]);
    expect(availableItemCount(campaign, "grenade")).toBe(8);
  });

  it("shares armory stock across all soldiers", () => {
    const campaign = freshCampaign();
    const ids = campaign.soldiers.map((soldier) => soldier.id);
    let next = campaign;
    for (let i = 0; i < 4; i += 1) {
      next = assignSoldierItem(next, ids[i]!, "grenade");
    }
    expect(availableItemCount(next, "grenade")).toBe(4);
    expect(canAssignSoldierItem(next, ids[4]!, "grenade")).toBe(true);
  });

  it("blocks assignment when armory stock is exhausted", () => {
    const campaign = freshCampaign();
    // Backpack capacity caps any single soldier at 4 grenades, so spread the 8-unit
    // armory stock across two soldiers (4 each) to exhaust it without ever hitting
    // the per-soldier backpack cap during setup.
    const firstId = campaign.soldiers[0]!.id;
    const secondId = campaign.soldiers[1]!.id;
    let next = campaign;
    for (let i = 0; i < 4; i += 1) {
      next = assignSoldierItem(next, firstId, "grenade");
    }
    for (let i = 0; i < 4; i += 1) {
      next = assignSoldierItem(next, secondId, "grenade");
    }
    expect(availableItemCount(next, "grenade")).toBe(0);
    expect(soldierItemIds(next, firstId).length).toBe(4);
    expect(soldierItemIds(next, secondId).length).toBe(4);

    // A third soldier with an empty backpack (plenty of room) is still blocked,
    // proving the block is driven by stock exhaustion, not backpack capacity.
    const thirdId = campaign.soldiers[2]!.id;
    expect(soldierItemIds(next, thirdId)).toEqual([]);
    expect(canAssignSoldierItem(next, thirdId, "grenade")).toBe(false);

    const blocked = assignSoldierItem(next, thirdId, "grenade");

    expect(blocked).toBe(next);
    expect(soldierItemIds(next, thirdId)).toEqual([]);
  });

  it("refuses to assign items to unknown or fallen soldiers", () => {
    const campaign = freshCampaign();
    expect(canAssignSoldierItem(campaign, "soldier-99", "grenade")).toBe(false);
    const firstId = campaign.soldiers[0]!.id;
    const fallen: CampaignState = {
      ...campaign,
      soldiers: campaign.soldiers.map((soldier) =>
        soldier.id === firstId ? { ...soldier, status: "kia" as const } : soldier,
      ),
    };
    expect(canAssignSoldierItem(fallen, firstId, "grenade")).toBe(false);
    expect(assignSoldierItem(fallen, firstId, "grenade")).toBe(fallen);
  });

  it("returns an assigned item to the armory on unassign", () => {
    const campaign = freshCampaign();
    const soldierId = campaign.soldiers[0]!.id;
    const armed = assignSoldierItem(campaign, soldierId, "medkit");
    expect(availableItemCount(armed, "medkit")).toBe(3);

    const cleared = unassignSoldierItem(armed, soldierId, "medkit");

    expect(soldierItemIds(cleared, soldierId)).toEqual([]);
    expect(availableItemCount(cleared, "medkit")).toBe(4);
  });

  it("removes only a single stacked instance on unassign", () => {
    const campaign = freshCampaign();
    const soldierId = campaign.soldiers[0]!.id;
    let armed = assignSoldierItem(campaign, soldierId, "grenade");
    armed = assignSoldierItem(armed, soldierId, "grenade");
    expect(soldierItemIds(armed, soldierId)).toEqual(["grenade", "grenade"]);

    const one = unassignSoldierItem(armed, soldierId, "grenade");

    expect(soldierItemIds(one, soldierId)).toEqual(["grenade"]);
    expect(availableItemCount(one, "grenade")).toBe(7);
  });

  it("is a no-op to unassign an item the soldier is not carrying", () => {
    const campaign = freshCampaign();
    const soldierId = campaign.soldiers[0]!.id;
    expect(unassignSoldierItem(campaign, soldierId, "grenade")).toBe(campaign);
  });

  it("maps deployed soldiers to their per-soldier loadout arrays", () => {
    const campaign = freshCampaign();
    expect(deploymentItemIds(campaign)).toEqual([[], [], [], []]);
    const deployed = campaign.deploymentSoldierIds;
    const first = deployed[0]!;
    const second = deployed[1]!;

    let next = assignSoldierItem(campaign, first, "grenade");
    next = assignSoldierItem(next, second, "medkit");
    next = assignSoldierItem(next, second, "grenade");

    const items = deploymentItemIds(next);
    expect(items.length).toBe(4);
    expect(items[0]).toEqual(["grenade"]);
    expect(items[1]).toEqual(["medkit", "grenade"]);
    expect(items[2]).toEqual([]);
    expect(items[3]).toEqual([]);
  });

  it("preserves item stock when a weapon is added to the armory (e.g. on recruit)", () => {
    const campaign = freshCampaign();
    const armed = assignSoldierItem(campaign, campaign.soldiers[0]!.id, "grenade");
    const recruited = recruitSoldier(armed);
    expect(recruited.armory.items?.grenade).toBe(7);
    expect(recruited.armory.items?.medkit).toBe(4);
  });

  it("defaults a legacy armory without items to the starting stock on load", () => {
    const campaign = freshCampaign();
    const legacy: CampaignState = {
      ...campaign,
      armory: { weapons: { ...campaign.armory.weapons } },
      soldiers: campaign.soldiers.map((soldier) => ({
        id: soldier.id,
        name: soldier.name,
        status: soldier.status,
        rank: soldier.rank,
        missions: soldier.missions,
        survivedMissions: soldier.survivedMissions,
        ...(soldier.woundedUntilHour !== undefined ? { woundedUntilHour: soldier.woundedUntilHour } : {}),
      })),
    };
    saveCampaign(legacy);

    const loaded = loadCampaign();

    expect(loaded).not.toBeNull();
    expect(loaded!.armory.items).toEqual({ grenade: 8, medkit: 4, smoke: 4, stunRod: 4 });
    expect(loaded!.soldiers[0]!.loadoutItems).toEqual([]);
  });

  it("preserves assigned item stock and loadouts across a save/load round-trip", () => {
    const campaign = freshCampaign();
    const soldierId = campaign.soldiers[0]!.id;
    const armed = assignSoldierItem(campaign, soldierId, "grenade");
    saveCampaign(armed);

    const loaded = loadCampaign();

    expect(loaded).not.toBeNull();
    expect(loaded!.armory.items?.grenade).toBe(7);
    expect(loaded!.soldiers[0]!.loadoutItems).toEqual(["grenade"]);
  });
});
