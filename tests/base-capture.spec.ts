/**
 * Throwaway capture: full-page screenshots of the base view to audit its layout.
 * Seeds a "rich" campaign (full roster + active research/manufacturing + a crashed
 * assault mission) so the base is shown at its most loaded, then captures the full
 * stacked page and the top viewport.
 */
import path from "node:path";
import { test } from "@playwright/test";
import { createCampaign, startResearch, startManufacturing, recruitSoldier } from "../src/campaign/storage";
import { createUfoContact, interceptUfo } from "../src/campaign/geoscape";
import type { BaseLocation, CampaignState } from "../src/campaign/types";

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
