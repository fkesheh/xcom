import { describe, expect, it } from "vitest";

import {
  advanceGeoscape,
  canLaunchInterceptor,
  canResolveInterception,
  createUfoContact,
  executeInterceptionAction,
  GEOSCAPE_SCAN_HOURS,
  interceptUfo,
  startInterceptionEncounter,
} from "../src/campaign/geoscape";
import { generateOperation } from "../src/campaign/operations";
import { createCampaign } from "../src/campaign/storage";
import type { CampaignState, DifficultyLevel, MissionType } from "../src/campaign/types";

const BASE = { lat: 2, lon: 14.2, region: "Africa" } as const;
const SEED = 12345;

function freshCampaign(): CampaignState {
  return createCampaign(BASE, SEED);
}

/** Spawn the deterministic hour-18 crashSite contact used across interception scenarios. */
function withTrackedContact(): CampaignState {
  return advanceGeoscape(freshCampaign(), 18);
}

function withDifficulty(campaign: CampaignState, difficulty: DifficultyLevel): CampaignState {
  return { ...campaign, strategic: { ...campaign.strategic, difficulty } };
}

describe("interactive interception encounters", () => {
  it("starts an engaging encounter that scales HP from strength and interceptor condition", () => {
    const detected = withTrackedContact();
    expect(canResolveInterception(detected)).toBe(false);

    const started = startInterceptionEncounter(detected);

    expect(started.ufoContact?.status).toBe("engaging");
    expect(started.interception).toBeDefined();
    expect(canResolveInterception(started)).toBe(true);
    expect(started.interception?.contactId).toBe(detected.ufoContact?.id);
    expect(started.interception?.range).toBe(3);
    expect(started.interception?.roundsElapsed).toBe(0);
    expect(started.interception?.ufoHp).toBe(started.interception?.ufoHpMax);
    expect(started.interception?.interceptorHp).toBe(started.interception?.interceptorHpMax);
    expect(started.interception?.log).toContain("Interception engaged");
  });

  it("exchanges fire on attack: the UFO is hit and returns fire on the interceptor", () => {
    const started = startInterceptionEncounter(withTrackedContact());
    const ufoHpBefore = started.interception!.ufoHp;
    const interceptorHpBefore = started.interception!.interceptorHp;

    const afterAttack = executeInterceptionAction(started, "attack");

    expect(afterAttack.interception).toBeDefined();
    expect(afterAttack.interception!.ufoHp).toBeLessThan(ufoHpBefore);
    expect(afterAttack.interception!.interceptorHp).toBeLessThan(interceptorHpBefore);
    expect(afterAttack.interception!.roundsElapsed).toBe(1);
    expect(afterAttack.interception!.log.length).toBeGreaterThan(started.interception!.log.length);
  });

  it("closes range without exchanging damage and bottoms out at zero", () => {
    const started = startInterceptionEncounter(withTrackedContact());

    const closer = executeInterceptionAction(started, "close");
    expect(closer.interception!.range).toBe(2);
    expect(closer.interception!.roundsElapsed).toBe(1);
    expect(closer.interception!.ufoHp).toBe(started.interception!.ufoHp);
    expect(closer.interception!.interceptorHp).toBe(started.interception!.interceptorHp);

    const pointBlank = executeInterceptionAction(
      executeInterceptionAction(executeInterceptionAction(closer, "close"), "close"),
      "close",
    );
    expect(pointBlank.interception!.range).toBe(0);
  });

  it("can shoot the UFO down over a sequence of attacks, clearing the encounter and recording a crash", () => {
    let state = startInterceptionEncounter(withTrackedContact());
    const contactId = state.ufoContact!.id;

    let guard = 0;
    while (canResolveInterception(state) && guard < 40) {
      const range = state.interception!.range;
      state = executeInterceptionAction(state, range > 0 ? "close" : "attack");
      guard += 1;
    }

    expect(state.ufoContact?.status).toBe("crashed");
    expect(state.ufoContact?.id).toBe(contactId);
    expect(state.interception).toBeUndefined();
    expect(canResolveInterception(state)).toBe(false);
    expect(state.lastInterceptionReport?.result).toBe("crashed");
    expect(state.lastInterceptionReport?.contactId).toBe(contactId);
    expect(state.interceptor.sorties).toBe(1);
    // The forced-down contact seeds a recoverable crash-site operation.
    expect(generateOperation(state).missionType).toBe("crashSite");
  });

  it("loses the interceptor in a lopsided engagement and records an escape", () => {
    const detected = withTrackedContact();
    const fragile: CampaignState = {
      ...detected,
      interceptor: { damage: 99, sorties: 0 },
    };

    const started = startInterceptionEncounter(fragile);
    expect(started.interception?.interceptorHp).toBe(1);

    const attacked = executeInterceptionAction(started, "attack");

    expect(attacked.ufoContact).toBeUndefined();
    expect(attacked.interception).toBeUndefined();
    expect(attacked.lastInterceptionReport?.result).toBe("escaped");
    expect(attacked.lastInterceptionReport?.contactId).toBe(started.ufoContact?.id);
    expect(attacked.interceptor.damage).toBe(100);
    expect(attacked.interceptor.sorties).toBe(1);
  });

  it("disengages back to tracked without further interceptor damage", () => {
    const started = startInterceptionEncounter(withTrackedContact());
    const damageBefore = started.interceptor.damage;

    const disengaged = executeInterceptionAction(started, "disengage");

    expect(disengaged.ufoContact?.status).toBe("tracked");
    expect(disengaged.interception).toBeUndefined();
    expect(canResolveInterception(disengaged)).toBe(false);
    expect(disengaged.interceptor.damage).toBe(damageBefore);
    expect(canLaunchInterceptor(disengaged)).toBe(true);
  });

  it("ignores actions when no encounter is in progress", () => {
    const detected = withTrackedContact();
    expect(executeInterceptionAction(detected, "attack")).toBe(detected);
    expect(executeInterceptionAction(detected, "close")).toBe(detected);
    expect(executeInterceptionAction(detected, "disengage")).toBe(detected);
  });

  it("rejects non-crashSite contacts from interception (ground assaults are not shoot-downs)", () => {
    const campaign = freshCampaign();
    const landed = createUfoContact(campaign, 18, "landedUfo");
    const withLanded: CampaignState = { ...campaign, ufoContact: landed };

    expect(landed.status).toBe("landed");
    expect(landed.missionType).toBe("landedUfo");
    expect(canLaunchInterceptor(withLanded)).toBe(false);
    expect(interceptUfo(withLanded)).toBe(withLanded);
    expect(startInterceptionEncounter(withLanded)).toBe(withLanded);
  });

  it("scales interception damage with difficulty (commander riskier than rookie)", () => {
    const closeToPointBlank = (state: CampaignState): CampaignState =>
      executeInterceptionAction(
        executeInterceptionAction(executeInterceptionAction(state, "close"), "close"),
        "close",
      );

    const rookie = executeInterceptionAction(
      closeToPointBlank(startInterceptionEncounter(withDifficulty(withTrackedContact(), "rookie"))),
      "attack",
    );
    const commander = executeInterceptionAction(
      closeToPointBlank(startInterceptionEncounter(withDifficulty(withTrackedContact(), "commander"))),
      "attack",
    );

    // Both UFOs survive a single point-blank volley, so both encounters stay live and comparable.
    expect(rookie.interception).toBeDefined();
    expect(commander.interception).toBeDefined();
    expect(commander.interception!.interceptorHp).toBeLessThan(rookie.interception!.interceptorHp);
    expect(commander.interception!.ufoHp).toBeLessThan(rookie.interception!.ufoHp);
  });
});

describe("instant auto-resolve regression", () => {
  it("resolves a tracked contact in a single interceptUfo call with no encounter state", () => {
    const detected = withTrackedContact();

    const intercepted = interceptUfo(detected);

    expect(intercepted.lastInterceptionReport).toBeDefined();
    expect(intercepted.lastInterceptionReport?.result).toBe("crashed");
    expect(intercepted.ufoContact?.status).toBe("crashed");
    expect(intercepted.interceptor.sorties).toBe(1);
    expect(intercepted.interception).toBeUndefined();
    expect(intercepted.lastInterceptionReport?.contactId).toBe(detected.ufoContact?.id);
  });
});

describe("contact mission-variety spawning", () => {
  it("defaults createUfoContact to a tracked crashSite contact (legacy 2-arg callers)", () => {
    const contact = createUfoContact(freshCampaign(), 18);

    expect(contact.status).toBe("tracked");
    expect(contact.missionType).toBe("crashSite");
  });

  it("spawns ground assaults in the landed status", () => {
    const campaign = freshCampaign();
    const terror = createUfoContact(campaign, 18, "terror");
    const defense = createUfoContact(campaign, 18, "baseDefense");

    expect(terror.status).toBe("landed");
    expect(terror.missionType).toBe("terror");
    expect(defense.status).toBe("landed");
    expect(defense.missionType).toBe("baseDefense");
  });

  it("rolls a deterministic mix of mission types across a seeded 30-day run", () => {
    const runVariety = (seed: number): MissionType[] => {
      let state = createCampaign(BASE, seed);
      const spawned: MissionType[] = [];
      const seen = new Set<number>();
      for (let i = 0; i < 120; i++) {
        state = advanceGeoscape(state, GEOSCAPE_SCAN_HOURS);
        const contact = state.ufoContact;
        if (contact && !seen.has(contact.detectedAtHour)) {
          seen.add(contact.detectedAtHour);
          spawned.push(contact.missionType ?? "crashSite");
        }
      }
      return spawned;
    };

    const first = runVariety(SEED);
    const again = runVariety(SEED);

    expect(first).toEqual(again);

    const types = new Set(first);
    expect(types.has("crashSite")).toBe(true);
    expect(types.has("landedUfo") || types.has("terror")).toBe(true);
  });
});
