import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createCampaign,
  canLaunchFinalAssault,
  saveCampaign,
  loadCampaign,
  CAMPAIGN_VICTORY_OPERATIONS,
} from "../src/campaign/storage";
import { advanceGeoscape, FUNDING_REPORT_INTERVAL_HOURS } from "../src/campaign/geoscape";
import type { CampaignState } from "../src/campaign/types";

const BASE = { lat: 39.0, lon: -77.0, region: "North America" } as const;
const SEED = 4242;

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

describe("council reports", () => {
  it("fires at the 720h boundary with month 1", () => {
    let campaign = createCampaign(BASE, SEED);
    expect(campaign.councilReports ?? []).toHaveLength(0);
    expect(campaign.lastCouncilMonth ?? 0).toBe(0);

    campaign = advanceGeoscape(campaign, FUNDING_REPORT_INTERVAL_HOURS);
    expect(campaign.lastCouncilMonth).toBe(1);
    expect(campaign.councilReports).toHaveLength(1);
    const report = campaign.councilReports![0]!;
    expect(report.month).toBe(1);
    expect(report.completedAtHour).toBe(FUNDING_REPORT_INTERVAL_HOURS);
    expect(report.regions.length).toBeGreaterThan(0);
    expect(typeof report.narrative).toBe("string");
    expect(report.narrative.length).toBeGreaterThan(0);
  });

  it("fires again at 1440h with month 2, keeping month 1 as the newest-first history", () => {
    let campaign = createCampaign(BASE, SEED);
    campaign = advanceGeoscape(campaign, FUNDING_REPORT_INTERVAL_HOURS);
    campaign = advanceGeoscape(campaign, FUNDING_REPORT_INTERVAL_HOURS);
    expect(campaign.lastCouncilMonth).toBe(2);
    expect(campaign.councilReports!.map((r) => r.month)).toEqual([2, 1]);
  });

  it("fast-forwarding past 3 boundaries in one advance produces 3 reports and lastCouncilMonth===3", () => {
    let campaign = createCampaign(BASE, SEED);
    campaign = advanceGeoscape(campaign, FUNDING_REPORT_INTERVAL_HOURS * 3);
    expect(campaign.lastCouncilMonth).toBe(3);
    expect(campaign.councilReports!.map((r) => r.month)).toEqual([3, 2, 1]);
  });

  it("region ratings reflect panic and infiltration", () => {
    let campaign = createCampaign(BASE, SEED);
    // Drive panic and infiltration up in one region before the first report fires,
    // via the same ignored-contact path advanceGeoscape already exercises.
    campaign = {
      ...campaign,
      regionalPanic: { ...campaign.regionalPanic, "North America": 80 },
      infiltration: { ...campaign.infiltration, "North America": 100 },
    };
    campaign = advanceGeoscape(campaign, FUNDING_REPORT_INTERVAL_HOURS);
    const report = campaign.councilReports![0]!;
    const hot = report.regions.find((r) => r.region === "North America")!;
    const cool = report.regions.find((r) => r.region !== "North America")!;
    expect(hot.panic).toBe(80);
    expect(hot.infiltration).toBe(100);
    expect(hot.defected).toBe(true);
    // A defected/high-panic region's funding delta is worse than an unaffected region's.
    expect(hot.fundingDelta).toBeLessThan(cool.fundingDelta);
    expect(report.totalFundingDelta).toBe(
      report.regions.reduce((sum, r) => sum + r.fundingDelta, 0),
    );
  });

  it("is not winnable before the first council report even with ops >= CAMPAIGN_VICTORY_OPERATIONS", () => {
    const campaign = createCampaign(BASE, SEED);
    const earlyWin: CampaignState = {
      ...campaign,
      missionsCompleted: CAMPAIGN_VICTORY_OPERATIONS,
      alienHq: campaign.alienHq ? { ...campaign.alienHq, revealed: true } : campaign.alienHq,
      lastCouncilMonth: 0,
    };
    expect(canLaunchFinalAssault(earlyWin)).toBe(false);

    const afterCouncil: CampaignState = { ...earlyWin, lastCouncilMonth: 1 };
    expect(canLaunchFinalAssault(afterCouncil)).toBe(true);
  });

  describe("save/load round trip", () => {
    beforeEach(installLocalStorageShim);
    afterEach(() => {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    });

    it("round-trips councilReports and lastCouncilMonth through loadCampaign", () => {
      let campaign = createCampaign(BASE, SEED);
      campaign = advanceGeoscape(campaign, FUNDING_REPORT_INTERVAL_HOURS * 2);
      expect(campaign.lastCouncilMonth).toBe(2);
      saveCampaign(campaign);

      const loaded = loadCampaign();
      expect(loaded).not.toBeNull();
      expect(loaded!.lastCouncilMonth).toBe(2);
      expect(loaded!.councilReports).toEqual(campaign.councilReports);
    });

    it("normalizes a missing/malformed councilReports field to an empty history", () => {
      const campaign = createCampaign(BASE, SEED);
      saveCampaign({ ...campaign, councilReports: undefined, lastCouncilMonth: undefined });
      const loaded = loadCampaign()!;
      expect(loaded.councilReports).toEqual([]);
      expect(loaded.lastCouncilMonth).toBe(0);
    });

    it("does not double-fire a report for a month already at lastCouncilMonth on reload", () => {
      let campaign = createCampaign(BASE, SEED);
      campaign = advanceGeoscape(campaign, FUNDING_REPORT_INTERVAL_HOURS);
      saveCampaign(campaign);
      const loaded = loadCampaign()!;
      // Re-advancing by less than a full interval past the persisted clock must not
      // re-fire month 1 (it keys off clock.lastFundingHour, which persisted too).
      const reAdvanced = advanceGeoscape(loaded, 1);
      expect(reAdvanced.lastCouncilMonth).toBe(1);
      expect(reAdvanced.councilReports).toHaveLength(1);
    });
  });
});
