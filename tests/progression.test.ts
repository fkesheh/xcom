import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { generateOperation } from "../src/campaign/operations";
import {
  CAMPAIGN_STORAGE_KEY,
  campaignSoldierStatBonus,
  createCampaign,
  deploymentSoldiers,
  loadCampaign,
  recordMissionResult,
  saveCampaign,
  soldierStatBonus,
} from "../src/campaign/storage";
import type { CampaignState, SoldierStatGrowth } from "../src/campaign/types";

const BASE = { lat: 2, lon: 14.2, region: "Africa" } as const;
const SEED = 12345;

/** Sum of a soldier's accumulated stat growth — the per-mission grant is 1..3. */
function totalGrowth(growth: SoldierStatGrowth | undefined): number {
  if (!growth) return 0;
  return growth.timeUnits + growth.health + growth.reactions + growth.firingAccuracy;
}

/** Runs one successful mission with the full squad surviving. */
function runSurvivedMission(campaign: CampaignState, completedAt = "2026-06-15T00:00:00.000Z"): CampaignState {
  const operation = generateOperation(campaign);
  const deployed = deploymentSoldiers(campaign).map((soldier) => soldier.id);
  return recordMissionResult(
    campaign,
    "success",
    operation,
    { deployedSoldierIds: deployed, survivingSoldierIds: deployed },
    completedAt,
  );
}

describe("soldier stat progression", () => {
  describe("surviving a mission grants deterministic growth", () => {
    it("a survivor gains between 1 and 3 stat points in a single stat", () => {
      const campaign = createCampaign(BASE, SEED);
      const deployed = deploymentSoldiers(campaign).map((soldier) => soldier.id);
      const survivorId = deployed[0]!;
      const before = campaign.soldiers.find((soldier) => soldier.id === survivorId)!;
      expect(totalGrowth(before.statGrowth)).toBe(0);

      const after = runSurvivedMission(campaign);
      const survivor = after.soldiers.find((soldier) => soldier.id === survivorId)!;

      const growth = survivor.statGrowth!;
      const nonZeroStats = ["timeUnits", "health", "reactions", "firingAccuracy"].filter(
        (stat) => growth[stat as keyof SoldierStatGrowth] > 0,
      );
      // Exactly one stat grows per mission, by 1..3.
      expect(nonZeroStats).toHaveLength(1);
      expect(totalGrowth(growth)).toBeGreaterThanOrEqual(1);
      expect(totalGrowth(growth)).toBeLessThanOrEqual(3);
    });

    it("is deterministic: the same mission from the same campaign yields identical growth", () => {
      const campaignA = createCampaign(BASE, SEED);
      const campaignB = createCampaign(BASE, SEED);
      const survivorId = deploymentSoldiers(campaignA)[0]!.id;

      const afterA = runSurvivedMission(campaignA);
      const afterB = runSurvivedMission(campaignB);

      const growthA = afterA.soldiers.find((soldier) => soldier.id === survivorId)!.statGrowth!;
      const growthB = afterB.soldiers.find((soldier) => soldier.id === survivorId)!.statGrowth!;
      expect(growthA).toEqual(growthB);

      // Different soldiers on the same mission get different (but still valid) growth,
      // because the soldier id is part of the seed.
      const otherId = deploymentSoldiers(campaignA)[1]!.id;
      const otherGrowth = afterA.soldiers.find((soldier) => soldier.id === otherId)!.statGrowth!;
      expect(totalGrowth(otherGrowth)).toBeGreaterThanOrEqual(1);
      expect(totalGrowth(otherGrowth)).toBeLessThanOrEqual(3);
    });
  });

  describe("KIA and non-deployed soldiers do not grow", () => {
    it("a soldier who is KIA does not gain stat growth", () => {
      const campaign = createCampaign(BASE, SEED);
      const deployed = deploymentSoldiers(campaign).map((soldier) => soldier.id);
      const operation = generateOperation(campaign);
      // Everyone but the last survivor is KIA.
      const soleSurvivorId = deployed[0]!;
      const kiaId = deployed[deployed.length - 1]!;

      const after = recordMissionResult(
        campaign,
        "success",
        operation,
        { deployedSoldierIds: deployed, survivingSoldierIds: [soleSurvivorId] },
        "2026-06-15T00:00:00.000Z",
      );

      const kia = after.soldiers.find((soldier) => soldier.id === kiaId)!;
      expect(kia.status).toBe("kia");
      // KIA soldiers keep whatever growth they had (none here) and earn nothing.
      expect(totalGrowth(kia.statGrowth)).toBe(0);

      const survivor = after.soldiers.find((soldier) => soldier.id === soleSurvivorId)!;
      expect(totalGrowth(survivor.statGrowth)).toBeGreaterThanOrEqual(1);
    });

    it("a soldier who was not deployed earns no growth", () => {
      const campaign = createCampaign(BASE, SEED);
      const deployed = deploymentSoldiers(campaign).map((soldier) => soldier.id);
      const benched = campaign.soldiers.filter((soldier) => !deployed.includes(soldier.id));
      expect(benched.length).toBeGreaterThan(0);
      const benchedId = benched[0]!.id;

      const after = runSurvivedMission(campaign);
      const stillBenched = after.soldiers.find((soldier) => soldier.id === benchedId)!;
      expect(totalGrowth(stillBenched.statGrowth)).toBe(0);
    });
  });

  describe("growth feeds into the effective stat bonus", () => {
    it("campaignSoldierStatBonus = rank bonus + accumulated growth", () => {
      const campaign = createCampaign(BASE, SEED);
      const survivorId = deploymentSoldiers(campaign)[0]!.id;

      const after = runSurvivedMission(campaign);
      const survivor = after.soldiers.find((soldier) => soldier.id === survivorId)!;
      const growth = survivor.statGrowth!;
      const rankBonus = soldierStatBonus(survivor);
      const effective = campaignSoldierStatBonus(after, survivor);

      expect(effective).toEqual({
        timeUnits: rankBonus.timeUnits + growth.timeUnits,
        health: rankBonus.health + growth.health,
        reactions: rankBonus.reactions + growth.reactions,
        firingAccuracy: rankBonus.firingAccuracy + growth.firingAccuracy,
      });
    });

    it("a fresh rookie with no growth has a zero effective bonus", () => {
      const campaign = createCampaign(BASE, SEED);
      const rookie = campaign.soldiers[0]!;
      expect(rookie.statGrowth).toEqual({ timeUnits: 0, health: 0, reactions: 0, firingAccuracy: 0 });
      expect(campaignSoldierStatBonus(campaign, rookie)).toEqual({
        timeUnits: 0,
        health: 0,
        reactions: 0,
        firingAccuracy: 0,
      });
    });
  });

  describe("growth compounds across a career", () => {
    it("multiple survived missions accumulate growth", () => {
      const campaign = createCampaign(BASE, SEED);
      const survivorId = deploymentSoldiers(campaign)[0]!.id;

      // Re-deploy the same soldier each mission by pinning the deployment roster.
      let current = campaign;
      const perMissionTotals: number[] = [];
      for (let i = 0; i < 4; i++) {
        current = recordMissionResult(
          current,
          "success",
          generateOperation(current),
          {
            deployedSoldierIds: deploymentSoldiers(current).map((soldier) => soldier.id),
            survivingSoldierIds: deploymentSoldiers(current).map((soldier) => soldier.id),
          },
          `2026-06-${15 + i}T00:00:00.000Z`,
        );
        const survivor = current.soldiers.find((soldier) => soldier.id === survivorId)!;
        perMissionTotals.push(totalGrowth(survivor.statGrowth));
      }

      const finalSurvivor = current.soldiers.find((soldier) => soldier.id === survivorId)!;
      const accumulated = totalGrowth(finalSurvivor.statGrowth);
      // Each mission grants 1..3, so four missions grant 4..12 total.
      expect(accumulated).toBeGreaterThanOrEqual(4);
      expect(accumulated).toBeLessThanOrEqual(12);
      // Cumulative totals rise strictly monotonically; each step's delta is 1..3.
      expect(perMissionTotals[0]).toBeGreaterThanOrEqual(1);
      expect(perMissionTotals[0]).toBeLessThanOrEqual(3);
      const deltas = perMissionTotals.map((total, index) =>
        total - (index === 0 ? 0 : perMissionTotals[index - 1]!),
      );
      for (const delta of deltas) {
        expect(delta).toBeGreaterThanOrEqual(1);
        expect(delta).toBeLessThanOrEqual(3);
      }
      // The accumulated total is exactly the sum of the per-mission grants.
      expect(deltas.reduce((sum, value) => sum + value, 0)).toEqual(accumulated);
      // And the accumulated total must exceed a single mission's grant.
      expect(perMissionTotals[0]!).toBeLessThan(accumulated);
      // A four-mission veteran also outranks a rookie.
      expect(finalSurvivor.survivedMissions).toBe(4);
      expect(soldierStatBonus(finalSurvivor).firingAccuracy).toBeGreaterThan(0);
    });

    it("growth is deterministic across a multi-mission career", () => {
      function runCareer(): SoldierStatGrowth {
        let current = createCampaign(BASE, SEED);
        const survivorId = deploymentSoldiers(current)[0]!.id;
        for (let i = 0; i < 3; i++) {
          current = recordMissionResult(
            current,
            "success",
            generateOperation(current),
            {
              deployedSoldierIds: deploymentSoldierIdsCurrent(current),
              survivingSoldierIds: deploymentSoldierIdsCurrent(current),
            },
            `2026-07-${10 + i}T00:00:00.000Z`,
          );
        }
        return current.soldiers.find((soldier) => soldier.id === survivorId)!.statGrowth!;
      }
      function deploymentSoldierIdsCurrent(c: CampaignState): string[] {
        return deploymentSoldiers(c).map((soldier) => soldier.id);
      }
      expect(runCareer()).toEqual(runCareer());
    });
  });

  describe("save/load normalization", () => {
    beforeEach(() => {
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
    });

    afterEach(() => {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (globalThis as { localStorage?: Storage }).localStorage;
    });

    it("persists accumulated growth across save/load", () => {
      const campaign = createCampaign(BASE, SEED);
      const survivorId = deploymentSoldiers(campaign)[0]!.id;
      const after = runSurvivedMission(campaign);
      const growthBefore = after.soldiers.find((soldier) => soldier.id === survivorId)!.statGrowth!;

      saveCampaign(after);
      const loaded = loadCampaign()!;
      const growthAfter = loaded.soldiers.find((soldier) => soldier.id === survivorId)!.statGrowth!;
      expect(growthAfter).toEqual(growthBefore);
    });

    it("defaults missing statGrowth to zeros when loading an old save", () => {
      const campaign = createCampaign(BASE, SEED);
      // Strip growth to simulate a pre-progression save, then persist raw JSON.
      const stripped: CampaignState = {
        ...campaign,
        soldiers: campaign.soldiers.map((soldier) => {
          const { statGrowth: _statGrowth, ...rest } = soldier;
          void _statGrowth;
          return rest;
        }),
      };
      localStorage.setItem(CAMPAIGN_STORAGE_KEY, JSON.stringify(stripped));

      const loaded = loadCampaign()!;
      for (const soldier of loaded.soldiers) {
        expect(soldier.statGrowth).toEqual({ timeUnits: 0, health: 0, reactions: 0, firingAccuracy: 0 });
      }
    });
  });
});
