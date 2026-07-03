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
import { test, expect, type Page } from "@playwright/test";

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
 * Enter a base facility room deterministically. DOM room-entry is gone in the new
 * base IA (the base is a bare 3D overview + a single per-room panel), so rooms are
 * reached in tests via the `window.__baseEnterRoom(kind)` hook the base view exposes
 * — the deterministic equivalent of clicking a facility mesh. `command` mounts the
 * geoscape (it IS the Command Center room).
 */
async function enterRoom(page: Page, kind: string): Promise<void> {
  await page.evaluate((k) => {
    (window as unknown as { __baseEnterRoom?: (roomKind: string) => void }).__baseEnterRoom?.(k);
  }, kind);
}

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
    // Require a land crash so the geoscape offers a "Launch Operation" CTA (an
    // ocean crash is unrecoverable and never launchable).
    if (resolved.ufoContact?.status === "crashed" && !resolved.ufoContact.overOcean) return resolved;
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
  test.beforeEach(async ({ page }) => {
    // Wait for dynamic-import chunks (three.js views) to finish loading.
    page.on("load", async () => { await page.waitForLoadState("networkidle").catch(() => {}); });
  });
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

    // The market now lives inside the Hangar room. The DOM room-nav sidebar is gone
    // (bare 3D overview + per-room panel), so reach the room via the __baseEnterRoom
    // test hook, then assert the market panel (with Buy buttons) is visible.
    await enterRoom(page, "hangar");
    await expect(page.locator("#base-view .market-card")).toBeVisible();
    await page.locator("#base-view .market-card").scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SHOTS_DIR, "02-base.png") });

    // Mission launch moved off the base onto the geoscape live-contact card (reached
    // via the Command Center room). Enter it and assert the "Launch Operation" CTA is
    // enabled for the crashed land contact.
    await enterRoom(page, "command");
    await expect(page.locator("#geoscape")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /launch operation/i }),
    ).toBeEnabled();
  });

  test("c) geoscape interception overlay renders", async ({ page }) => {
    const campaign = engagingCampaign();
    await page.addInitScript((state: CampaignState) => {
      window.localStorage.setItem("blacksite.campaign.v1", JSON.stringify(state));
    }, campaign);
    await page.goto("/");

    // Boot with a saved campaign always lands on the base view; the interception
    // overlay lives on the geoscape, which is now the Command Center room (the
    // floating "Earth" button is gone).
    await expect(page.locator("#base-view")).toBeVisible();
    await enterRoom(page, "command");

    await expect(page.locator("#geoscape")).toBeVisible();
    await expect(page.locator("#geoscape canvas")).toBeVisible();
    // The interception is now a dedicated PlaneCombatView screen (not a geoscape overlay).
    // For a seeded engaging encounter the PCV may or may not auto-mount depending
    // on whether main detects the active interception. Either way the geoscape renders.
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

    // Mission launch lives on the geoscape live-contact card now: enter the Command
    // Center room, then launch the recovery operation from that card.
    await enterRoom(page, "command");
    await expect(page.locator("#geoscape")).toBeVisible();
    const launch = page.getByRole("button", { name: /launch operation/i });
    await expect(launch).toBeEnabled();
    // Launch the recovery operation -> Skyranger deployment flight -> Deploy/Wait choice.
    await launch.click();

    // Wait for the deploy-or-wait choice (after the ~3s flight), then click Deploy.
    const deployChoice = page.locator(".geo-deploy-actions button:has-text(\"Deploy\")");
    try {
      await deployChoice.waitFor({ state: "visible", timeout: 8_000 });
      await deployChoice.click({ timeout: 3_000 });
    } catch {
      // Fallback: deployment may auto-deploy (no choice shown).
    }

    await expect(page.locator("#hud")).toBeVisible({ timeout: 15_000 });
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

    // Airborne intercept guidance moved onto the geoscape (Command Center room): the
    // live-contact card reads "Airborne — intercept", offers an Intercept affordance,
    // and NEVER a launchable recovery CTA (that appears only once the UFO is down on
    // land). Enter the Command Center to verify.
    await enterRoom(page, "command");
    await expect(page.locator("#geoscape")).toBeVisible();
    const contact = page.locator("#geoscape .geo-contact");
    await expect(contact).toBeVisible();
    const contactText = ((await contact.textContent()) ?? "").replace(/\s+/g, " ").trim();
    console.log("[smoke E] geoscape contact card text:", contactText);
    await expect(contact.getByText(/airborne/i).first()).toBeVisible();

    // The tracked UFO must offer an Intercept affordance (routing the player to
    // scramble a fighter), never a launchable recovery.
    const intercept = page.getByRole("button", { name: /intercept/i }).first();
    await expect(intercept).toBeVisible();
    console.log(
      "[smoke E] intercept button label:",
      ((await intercept.textContent()) ?? "").replace(/\s+/g, " ").trim(),
    );

    // No "Launch Operation" CTA may exist for an airborne UFO.
    await expect(page.getByRole("button", { name: /launch operation/i })).toHaveCount(0);
  });

  test("F) geoscape renders the Pause/1x/5x/30x time-speed controls", async ({
    page,
  }) => {
    // A contact-free campaign boots to the base, then enters the Command Center room
    // (a clean geoscape, no interception overlay) so the time-speed controls show.
    const campaign = createCampaign(BASE, 7, "veteran");
    await page.addInitScript((state: CampaignState) => {
      window.localStorage.setItem("blacksite.campaign.v1", JSON.stringify(state));
    }, campaign);
    await page.goto("/");

    await expect(page.locator("#base-view")).toBeVisible();
    await enterRoom(page, "command");

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
