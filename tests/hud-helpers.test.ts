import { describe, it, expect } from "vitest";
import { MORALE } from "../src/sim/types";
import type { ReserveMode, Weapon } from "../src/sim/types";
import {
  itemActionTuCost,
  moraleState,
  reservedTuForReserve,
} from "../src/game/hud";

describe("itemActionTuCost", () => {
  it("charges the full tuPercent for throw and use, half for prime", () => {
    // grenade: tuPercent 30, max TU 60 -> throw 18 TU, prime 9 TU
    expect(itemActionTuCost(60, 30, "throw")).toBe(18);
    expect(itemActionTuCost(60, 30, "use")).toBe(18);
    expect(itemActionTuCost(60, 30, "prime")).toBe(9);
    // medkit: tuPercent 40, max TU 60 -> use 24 TU
    expect(itemActionTuCost(60, 40, "use")).toBe(24);
  });

  it("rounds up like the sim does", () => {
    // 55 * 30 / 100 = 16.5 -> ceil 17
    expect(itemActionTuCost(55, 30, "throw")).toBe(17);
    // 55 * 30 * 0.5 / 100 = 8.25 -> ceil 9
    expect(itemActionTuCost(55, 30, "prime")).toBe(9);
  });

  it.each<[number, number]>([
    [0, 0],
    [50, 40],
  ])("mirrors the sim formula for throw/use vs prime (maxTu=%i, tuPct=%i)", (maxTu, tuPct) => {
    const full = Math.ceil((maxTu * tuPct) / 100);
    const half = Math.ceil((maxTu * tuPct * 0.5) / 100);
    expect(itemActionTuCost(maxTu, tuPct, "throw")).toBe(full);
    expect(itemActionTuCost(maxTu, tuPct, "use")).toBe(full);
    expect(itemActionTuCost(maxTu, tuPct, "prime")).toBe(half);
  });
});

describe("reservedTuForReserve", () => {
  const rifle: Weapon = {
    id: "rifle",
    name: "Service Rifle",
    damage: 26,
    range: 12,
    magazineSize: 24,
    reloadTuPercent: 20,
    modes: [
      { kind: "snap", tuPercent: 25, accuracy: 60, shots: 1 },
      { kind: "aimed", tuPercent: 50, accuracy: 110, shots: 1 },
      { kind: "auto", tuPercent: 35, accuracy: 35, shots: 3 },
    ],
  };

  it("returns 0 for none regardless of weapon", () => {
    expect(reservedTuForReserve(60, "none", rifle)).toBe(0);
    expect(reservedTuForReserve(60, "none", undefined)).toBe(0);
  });

  it("computes reserve TU from the matching mode's tuPercent", () => {
    // maxTu 60: snap 25% -> 15, aimed 50% -> 30, auto 35% -> 21
    expect(reservedTuForReserve(60, "snap", rifle)).toBe(15);
    expect(reservedTuForReserve(60, "aimed", rifle)).toBe(30);
    expect(reservedTuForReserve(60, "auto", rifle)).toBe(21);
  });

  it("returns 0 when the reserved mode is absent from the weapon", () => {
    const pistol: Weapon = {
      id: "pistol",
      name: "Sidearm",
      damage: 18,
      range: 8,
      magazineSize: 12,
      reloadTuPercent: 18,
      modes: [
        { kind: "snap", tuPercent: 18, accuracy: 55, shots: 1 },
        { kind: "aimed", tuPercent: 40, accuracy: 95, shots: 1 },
      ],
    };
    // auto is not a pistol mode
    expect(reservedTuForReserve(60, "auto" as ReserveMode, pistol)).toBe(0);
  });
});

describe("moraleState", () => {
  it("reads undefined morale as steady (units opting out of the system)", () => {
    expect(moraleState(undefined)).toEqual({ tone: "steady", label: "Steady" });
  });

  it("flags at-or-below the panic threshold as PANIC", () => {
    expect(moraleState(MORALE.PANIC_THRESHOLD).tone).toBe("panic");
    expect(moraleState(MORALE.PANIC_THRESHOLD).label).toBe("PANIC");
    expect(moraleState(0).tone).toBe("panic");
    expect(moraleState(MORALE.PANIC_THRESHOLD + 1).tone).not.toBe("panic");
  });

  it("reads mid-range morale as shaken and high morale as steady", () => {
    expect(moraleState(50).tone).toBe("shaken");
    expect(moraleState(66).tone).toBe("shaken");
    expect(moraleState(67).tone).toBe("steady");
    expect(moraleState(MORALE.MAX).tone).toBe("steady");
  });

  it("always returns a non-empty label so colour is never the sole signal", () => {
    for (const value of [0, 10, 35, 36, 50, 66, 67, 100]) {
      expect(moraleState(value).label.length).toBeGreaterThan(0);
    }
  });
});
