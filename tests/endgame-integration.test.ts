/**
 * Endgame rank-channel integration: prove that the `enemyRanks` composition
 * supplied by the campaign layer (ufoCrewRanks / alienBaseCrewRanks) lands on the
 * spawned hostile units with the right templates and ranks, so captures for
 * containment/interrogation carry meaningful ranks all the way from the operation
 * plan into the battlescape.
 */
import { describe, it, expect } from "vitest";
import { createSkirmish } from "../src/sim/setup";
import { alienBaseCrewRanks, ufoCrewRanks } from "../src/campaign/operations";
import type { EnemyRank } from "../src/sim/types";

/** Rank → carrier template mapping mirrored from setup.templateIdForRank. */
const RANK_TEMPLATES: Record<EnemyRank, readonly string[]> = {
  soldier: ["drone", "stalker"],
  navigator: ["sentinel"],
  leader: ["heavy"],
  commander: ["commander"],
};

function enemyUnits(seed: number, enemyRanks: readonly EnemyRank[]) {
  const state = createSkirmish({ seed, width: 40, height: 40, players: 4, enemyRanks });
  return state.units.filter((u) => u.faction === "enemy");
}

describe("endgame rank channel", () => {
  it("spawns one hostile per requested rank with a matching template", () => {
    const ranks: EnemyRank[] = ["commander", "leader", "navigator", "soldier", "soldier"];
    const enemies = enemyUnits(4242, ranks);
    // A big enough map yields a spawn tile per requested rank.
    expect(enemies.length).toBe(ranks.length);
    for (let i = 0; i < enemies.length; i++) {
      const unit = enemies[i]!;
      const wantRank = ranks[i]!;
      expect(unit.rank).toBe(wantRank);
      expect(RANK_TEMPLATES[wantRank]).toContain(unit.templateId);
    }
  });

  it("maps commander/leader/navigator to their carrier templates", () => {
    const enemies = enemyUnits(99, ["commander", "leader", "navigator"]);
    expect(enemies[0]!.templateId).toBe("commander");
    expect(enemies[0]!.rank).toBe("commander");
    expect(enemies[1]!.templateId).toBe("heavy");
    expect(enemies[1]!.rank).toBe("leader");
    expect(enemies[2]!.templateId).toBe("sentinel");
    expect(enemies[2]!.rank).toBe("navigator");
  });

  it("alternates soldiers between drone and stalker deterministically", () => {
    const enemies = enemyUnits(7, ["soldier", "soldier", "soldier", "soldier"]);
    expect(enemies.map((u) => u.templateId)).toEqual(["drone", "stalker", "drone", "stalker"]);
  });

  it("honors an alienBaseCrewRanks composition (always a commander + leader)", () => {
    const ranks = alienBaseCrewRanks(12345);
    expect(ranks).toContain("commander");
    expect(ranks).toContain("leader");
    const enemies = enemyUnits(12345, ranks);
    expect(enemies.length).toBe(ranks.length);
    expect(enemies.map((u) => u.rank)).toEqual([...ranks]);
    expect(enemies.some((u) => u.templateId === "commander")).toBe(true);
  });

  it("honors a ufoCrewRanks composition on spawned units", () => {
    const ranks = ufoCrewRanks("battleship", 555, 6);
    const enemies = enemyUnits(555, ranks);
    expect(enemies.length).toBe(ranks.length);
    for (let i = 0; i < enemies.length; i++) {
      expect(enemies[i]!.rank).toBe(ranks[i]!);
    }
  });

  it("falls back to legacy drone/sentinel spawns when no ranks supplied", () => {
    const state = createSkirmish({ seed: 1, width: 30, height: 30, players: 4, enemies: 4 });
    const enemies = state.units.filter((u) => u.faction === "enemy");
    expect(enemies.length).toBe(4);
    for (const u of enemies) {
      expect(["drone", "sentinel"]).toContain(u.templateId);
    }
  });
});
