/** Capture the geoscape with a tracked UFO (patrol planes flying) + time flowing (night). */
import path from "node:path";
import { test } from "@playwright/test";
import { createCampaign } from "../src/campaign/storage";
import { createUfoContact } from "../src/campaign/geoscape";
import type { BaseLocation, CampaignState } from "../src/campaign/types";

const SHOTS = path.resolve(process.cwd(), "tests", "smoke-shots");
const BASE: BaseLocation = { lat: 48.2, lon: 14.6, region: "Europe" };

test("capture geoscape with UFO + planes + night", async ({ page }) => {
  let c = createCampaign(BASE, 3, "veteran");
  c = { ...c, ufoContact: createUfoContact(c, 0) };
  await page.addInitScript((state: CampaignState) => {
    window.localStorage.setItem("blacksite.campaign.v1", JSON.stringify(state));
  }, c);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await page.locator("#base-view").waitFor();
  await page.waitForTimeout(500);
  // Go to geoscape (boot lands on base with a saved campaign). Force-click past any overlay.
  await page.locator('button:has-text("Earth")').click({ force: true });
  await page.locator("#geoscape").waitFor();
  // Let time flow for ~3s so planes patrol + night creeps.
  await page.waitForTimeout(3500);
  await page.locator("#geoscape canvas").first().screenshot({ path: path.join(SHOTS, "geo-live.png") });
});
