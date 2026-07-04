/**
 * Throwaway capture: full-page screenshots of the base view to audit its layout.
 * Seeds a "rich" campaign (full roster + active research/manufacturing + a crashed
 * assault mission) so the base is shown at its most loaded, then captures the full
 * stacked page and each carousel-driven facility room (research / manufacturing /
 * barracks), which replaced the old scrolling card lists.
 */
import path from "node:path";
import { test, expect } from "@playwright/test";
import { createCampaign, startResearch, startManufacturing, recruitSoldier } from "../src/campaign/storage";
import { createUfoContact, interceptUfo } from "../src/campaign/geoscape";
import type { BaseLocation, CampaignState } from "../src/campaign/types";
import type { FacilityKind } from "../src/campaign/base";

const SHOTS = path.resolve(process.cwd(), "tests", "smoke-shots");
const BASE: BaseLocation = { lat: 48.2, lon: 14.6, region: "Europe" };

function richCampaign(): CampaignState {
  for (let seed = 1; seed <= 8192; seed++) {
    let c = createCampaign(BASE, seed, "veteran");
    c = { ...c, ufoContact: createUfoContact(c, 0) };
    c = interceptUfo(c);
    if (c.ufoContact?.status !== "crashed") continue;
    try {
      c = recruitSoldier(c);
      c = recruitSoldier(c);
      c = startResearch(c, "plasmaWeapons");
      c = startManufacturing(c, "rifle");
    } catch {
      /* best effort */
    }
    return c;
  }
  throw new Error("no seed");
}

test("capture base view full-page (rich)", async ({ page }) => {
  const c = richCampaign();
  await page.addInitScript((state: CampaignState) => {
    window.localStorage.setItem("blacksite.campaign.v1", JSON.stringify(state));
  }, c);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.locator("#base-view").waitFor();
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(SHOTS, "audit-base-rich-full.png"), fullPage: true });
  await page.screenshot({ path: path.join(SHOTS, "audit-base-rich-top.png") });

  // The research / manufacturing / barracks rooms are now one-item-at-a-time
  // carousels (createCarousel) rather than scrolling card lists. Dive into each
  // via the deterministic room-entry hook and capture the full-detail slide +
  // jump strip. `lab`→research, `workshop`→engineering, `living`→barracks.
  const rooms: { kind: FacilityKind; shot: string }[] = [
    { kind: "lab", shot: "audit-base-research-carousel.png" },
    { kind: "workshop", shot: "audit-base-manufacturing-carousel.png" },
    { kind: "living", shot: "audit-base-barracks-carousel.png" },
  ];
  await page.waitForFunction(() => typeof window.__baseEnterRoom === "function");
  for (const room of rooms) {
    await page.evaluate((kind) => window.__baseEnterRoom?.(kind), room.kind);
    await page.waitForTimeout(400);
    // Every carousel room mounts a .bs-carousel with a jump strip of all items.
    const carousel = page.locator(".bs-carousel").first();
    await carousel.waitFor();
    await expect(page.locator(".bs-carousel__cell").first()).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, room.shot) });
  }
});

test("capture base view full-page (fresh, no contact)", async ({ page }) => {
  const c = createCampaign(BASE, 7, "veteran");
  await page.addInitScript((state: CampaignState) => {
    window.localStorage.setItem("blacksite.campaign.v1", JSON.stringify(state));
  }, c);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.locator("#base-view").waitFor();
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(SHOTS, "audit-base-fresh-full.png"), fullPage: true });
});
