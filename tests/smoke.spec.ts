/**
 * Browser smoke test: loads the real built app (served by `vite preview`) and
 * exercises every major screen, capturing a screenshot of each and asserting
 * that ZERO uncaught exceptions / console.error messages occur.
 *
 * Seed campaign states are built in Node by importing the pure logic modules
 * (`src/campaign/*`) and injected into the page via `page.addInitScript` so the
 * boot path in `src/game/main.ts` reads them out of localStorage.
 */
import path from "node:path";
import { test, expect } from "@playwright/test";

import { createCampaign } from "../src/campaign/storage";
import {
  createUfoContact,
  interceptUfo,
  startInterceptionEncounter,
} from "../src/campaign/geoscape";
import type {
  BaseLocation,
  CampaignState,
  DifficultyLevel,
} from "../src/campaign/types";

const SHOTS_DIR = path.resolve(process.cwd(), "tests", "smoke-shots");

const BASE: BaseLocation = { lat: 48.2, lon: 14.6, region: "Europe" };

/**
 * Build a campaign whose UFO contact is a launchable crash site. `interceptUfo`
 * auto-resolves based on the interceptor/UFO score forecast, so we search seeds
 * until the contact is actually forced down (status "crashed").
 */
function crashedCampaign(difficulty: DifficultyLevel = "veteran"): CampaignState {
  for (let seed = 1; seed <= 8192; seed++) {
    const fresh = createCampaign(BASE, seed, difficulty);
    const tracked = { ...fresh, ufoContact: createUfoContact(fresh, 0) };
    const resolved = interceptUfo(tracked);
    if (resolved.ufoContact?.status === "crashed") return resolved;
  }
  throw new Error("Unable to build a crashed-contact campaign for smoke test");
}

/** Build a campaign with an in-progress interactive interception encounter. */
function engagingCampaign(difficulty: DifficultyLevel = "veteran"): CampaignState {
  const fresh = createCampaign(BASE, 123, difficulty);
  const tracked = { ...fresh, ufoContact: createUfoContact(fresh, 0) };
  return startInterceptionEncounter(tracked);
}

// ---------------------------------------------------------------------------
// Zero-error gate: every console.error / pageerror is collected and asserted
// empty at the end of each test. A single entry fails the test verbatim.
// ---------------------------------------------------------------------------

const collectedErrors: string[] = [];

test.beforeEach(async ({ page }) => {
  collectedErrors.length = 0;
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      collectedErrors.push(`[console.error] ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => {
    collectedErrors.push(`[pageerror] ${err.toString()}\n${err.stack ?? ""}`);
  });
});

test.afterEach(async () => {
  if (collectedErrors.length > 0) {
    throw new Error(
      `Expected zero console/page errors, got ${collectedErrors.length}:\n` +
        collectedErrors.join("\n---\n"),
    );
  }
});

// ---------------------------------------------------------------------------

test.describe("Blacksite boot smoke", () => {
  test("a) new-game geoscape renders the difficulty selector", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.clear();
    });
    await page.goto("/");

    await expect(page.locator("#geoscape")).toBeVisible();
    await expect(page.locator("#geoscape canvas")).toBeVisible();
    // Difficulty radiogroup is only present on the new-game geoscape.
    await expect(page.locator(".geo-difficulty")).toBeVisible();
    await expect(page.getByText(/Select difficulty/i)).toBeVisible();

    await page.screenshot({ path: path.join(SHOTS_DIR, "01-newgame.png") });
  });

  test("b) base screen renders the market + launchable mission card", async ({ page }) => {
    const campaign = crashedCampaign();
    await page.addInitScript((state: CampaignState) => {
      // NOTE: addInitScript serializes this fn to a string and runs it in the
      // page, so it cannot close over module-scope vars — the key is inlined.
      window.localStorage.setItem("blacksite.campaign.v1", JSON.stringify(state));
    }, campaign);
    await page.goto("/");

    await expect(page.locator("#base-view")).toBeVisible();
    await expect(page.locator("#base-view canvas")).toBeVisible();
    await expect(page.locator("#base-view .operation-card")).toBeVisible();
    // Launch button is enabled (crashed contact + active squad).
    await expect(
      page.getByRole("button", { name: /recover ufo core/i }),
    ).toBeEnabled();

    // The market now lives inside the Hangar room — open it from the base hub's
    // facility list, then assert the market panel (with Buy buttons) is visible
    // for the screenshot.
    await page.getByRole("button", { name: /hangar & armory/i }).click();
    await expect(page.locator("#base-view .market-card")).toBeVisible();

    // Scroll the market into view for a representative screenshot.
    await page.locator("#base-view .market-card").scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SHOTS_DIR, "02-base.png") });
  });

  test("c) geoscape interception overlay renders", async ({ page }) => {
    const campaign = engagingCampaign();
    await page.addInitScript((state: CampaignState) => {
      window.localStorage.setItem("blacksite.campaign.v1", JSON.stringify(state));
    }, campaign);
    await page.goto("/");

    // Boot with a saved campaign always lands on the base view; the
    // interception overlay lives on the geoscape, so hop over via "Earth".
    await expect(page.locator("#base-view")).toBeVisible();
    await page.getByRole("button", { name: /^earth$/i }).click();

    await expect(page.locator("#geoscape")).toBeVisible();
    await expect(page.locator("#geoscape canvas")).toBeVisible();
    // Overlay shows only while campaign.interception is set.
    await expect(page.locator("#geoscape .geo-overlay")).toBeVisible();
    await expect(page.locator("#geoscape .geo-encounter")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^attack$/i }),
    ).toBeVisible();

    await page.screenshot({ path: path.join(SHOTS_DIR, "03-interception.png") });
  });

  test("d) tactical screen mounts after launch (end-turn + item best-effort)", async ({
    page,
  }) => {
    const campaign = crashedCampaign();
    await page.addInitScript((state: CampaignState) => {
      window.localStorage.setItem("blacksite.campaign.v1", JSON.stringify(state));
    }, campaign);
    await page.goto("/");

    // Start from the base screen.
    await expect(page.locator("#base-view")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /recover ufo core/i }),
    ).toBeEnabled();

    // Launch the recovery operation -> controller mounts the tactical view.
    await page.getByRole("button", { name: /recover ufo core/i }).click();

    await expect(page.locator("#hud")).toBeVisible();
    await expect(page.locator("#app canvas")).toBeVisible();

    // Dismiss the opening briefing overlay so the battlefield is visible.
    const deployBtn = page.locator("#hud .briefing.show button", {
      hasText: /deploy squad/i,
    });
    if ((await deployBtn.count()) > 0) {
      await deployBtn.first().click();
      await page.waitForTimeout(500);
    }

    await page.screenshot({ path: path.join(SHOTS_DIR, "04-tactical.png") });

    // Best-effort: enter an item targeting mode (grenade throw / medkit use).
    // Attempted on the fresh player turn (unit selected, full TU) — the most
    // reliable moment; after the enemy turn the HUD can still be `busy`.
    const itemAction = page
      .locator("#hud .item-line button:not([disabled])")
      .first();
    try {
      await itemAction.waitFor({ state: "visible", timeout: 2_000 });
      await itemAction.click({ timeout: 3_000 });
      await page.waitForTimeout(500);
      await page.screenshot({
        path: path.join(SHOTS_DIR, "06-tactical-itemmode.png"),
      });
    } catch {
      console.log(
        "[smoke] no usable item action button found — skipping item-mode screenshot",
      );
    }

    // Best-effort: end the player's turn and capture the enemy-turn state.
    const endTurn = page.locator("#hud .endturn");
    await expect(endTurn).toBeVisible();
    try {
      await endTurn.click({ timeout: 5_000 });
      // Let the enemy turn animate/resolve before the next capture.
      await page.waitForTimeout(2_500);
    } catch (err) {
      console.log("[smoke] end-turn click skipped:", String(err));
    }
    await page.screenshot({
      path: path.join(SHOTS_DIR, "05-tactical-endturn.png"),
    });
  });

  test("E) airborne (tracked) UFO shows intercept guidance, not a launchable mission", async ({
    page,
  }) => {
    // Tracked = airborne UFO that has NOT been shot down yet. The base must route
    // the player to intercept first, never offer a launchable crash-site mission.
    const fresh = createCampaign(BASE, 42, "veteran");
    const tracked: CampaignState = {
      ...fresh,
      ufoContact: createUfoContact(fresh, 0),
    };
    await page.addInitScript((state: CampaignState) => {
      window.localStorage.setItem("blacksite.campaign.v1", JSON.stringify(state));
    }, tracked);
    await page.goto("/");

    await expect(page.locator("#base-view")).toBeVisible();
    await expect(page.locator("#base-view canvas")).toBeVisible();

    await page.screenshot({ path: path.join(SHOTS_DIR, "07-base-airborne.png") });

    // Guidance: an airborne banner names the contact and routes the player to the
    // Geoscape to intercept — never a launchable crash-site assault mission.
    const banner = page.locator("#base-view .airborne-banner.tracked");
    await expect(banner).toBeVisible();
    const bannerText = ((await banner.textContent()) ?? "").replace(/\s+/g, " ").trim();
    console.log("[smoke E] airborne banner text:", bannerText);
    await expect(banner.getByText(/airborne ufo detected/i)).toBeVisible();

    // The launch button must read "Intercept first" and be DISABLED.
    const interceptFirst = page.getByRole("button", { name: /^intercept first$/i });
    await expect(interceptFirst).toBeVisible();
    await expect(interceptFirst).toBeDisabled();
    console.log(
      "[smoke E] launch button label:",
      ((await interceptFirst.textContent()) ?? "").replace(/\s+/g, " ").trim(),
    );

    // No enabled "Recover UFO core" launch button may exist for an airborne UFO.
    const recoverBtn = page.getByRole("button", { name: /recover ufo core/i });
    const recoverCount = await recoverBtn.count();
    if (recoverCount > 0) {
      console.log("[smoke E] 'Recover UFO core' present — asserting it is disabled");
      await expect(recoverBtn.first()).toBeDisabled();
    } else {
      console.log("[smoke E] 'Recover UFO core' correctly absent for airborne UFO");
    }
  });

  test("F) geoscape renders the Pause/1x/5x/30x time-speed controls", async ({
    page,
  }) => {
    // A contact-free campaign boots to the base, then hops to a clean geoscape
    // (no interception overlay) so the main time-speed controls are on display.
    const campaign = createCampaign(BASE, 7, "veteran");
    await page.addInitScript((state: CampaignState) => {
      window.localStorage.setItem("blacksite.campaign.v1", JSON.stringify(state));
    }, campaign);
    await page.goto("/");

    await expect(page.locator("#base-view")).toBeVisible();
    await page.getByRole("button", { name: /^earth$/i }).click();

    await expect(page.locator("#geoscape")).toBeVisible();
    await expect(page.locator("#geoscape canvas")).toBeVisible();

    await page.screenshot({ path: path.join(SHOTS_DIR, "08-geoscape-time.png") });

    // Time-speed control group with the Pause / 1x / 5x / 30x buttons.
    const speedGroup = page.locator("#geoscape .geo-speed");
    await expect(speedGroup).toBeVisible();
    const speedBtns = page.locator("#geoscape .geo-speed-btn");
    await expect(speedBtns).toHaveCount(4);
    const labels = await speedBtns.allTextContents();
    console.log(
      "[smoke F] time-speed button labels:",
      labels.map((t) => t.replace(/\s+/g, " ").trim()),
    );

    // Pause + each speed button must render (campaign is active, so they're enabled).
    await expect(page.locator("#geoscape .geo-speed-btn[data-speed='0']")).toBeVisible();
    await expect(page.locator("#geoscape .geo-speed-btn[data-speed='1']")).toBeVisible();
    await expect(page.locator("#geoscape .geo-speed-btn[data-speed='5']")).toBeVisible();
    await expect(page.locator("#geoscape .geo-speed-btn[data-speed='30']")).toBeVisible();
  });
});
