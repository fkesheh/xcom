/** Throwaway: dive into a facility interior and capture it. */
import path from "node:path";
import { test } from "@playwright/test";
import { createCampaign } from "../src/campaign/storage";
import type { BaseLocation, CampaignState } from "../src/campaign/types";

const SHOTS = path.resolve(process.cwd(), "tests", "smoke-shots");
const BASE: BaseLocation = { lat: 48.2, lon: 14.6, region: "Europe" };

test("capture a facility interior (dive)", async ({ page }) => {
  const c: CampaignState = createCampaign(BASE, 7, "veteran");
  await page.addInitScript((state: CampaignState) => {
    window.localStorage.setItem("blacksite.campaign.v1", JSON.stringify(state));
  }, c);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await page.locator("#base-view").waitFor();
  await page.waitForTimeout(900);
  // Open the Construction room (where facility rows live), then click the first facility row to dive.
  const construction = page.getByRole("button", { name: /construction/i }).first();
  if (await construction.count()) { await construction.click(); await page.waitForTimeout(400); }
  // A facility row in the construction list; click the first to trigger selectFacility -> dive.
  const rows = page.locator("#base-view .facility-row, #base-view [data-facility], #base-view button.room-card");
  const n = await rows.count();
  if (n > 0) { await rows.first().click(); await page.waitForTimeout(1300); }
  await page.locator("#base-view canvas").first().screenshot({ path: path.join(SHOTS, "base-interior.png") });
  await page.screenshot({ path: path.join(SHOTS, "base-interior-full.png") });
});
