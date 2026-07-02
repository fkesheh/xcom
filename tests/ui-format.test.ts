import { describe, it, expect } from "vitest";
import {
  formatHours,
  formatDuration,
  formatPercent,
  ratioToPercent,
  formatCredits,
  formatSignedCredits,
} from "../src/game/uiFormat";

describe("formatHours", () => {
  it.each<[number, string]>([
    [0, "0h"],
    [1, "1h"],
    [23, "23h"],
    [23.4, "23h"],
    [23.4999, "23h"],
  ])("under a day: formatHours(%f) -> %s", (input, expected) => {
    expect(formatHours(input)).toBe(expected);
  });

  it.each<[number, string]>([
    [23.6, "1d"], // rounds up to 24 -> exactly one day
    [24, "1d"],
    [43.93333333333321, "1d 20h"], // the reported float bug: clean integer d/h
    [44, "1d 20h"],
    [47.5, "2d"], // 47.5 -> 48 -> exactly 2d, no hours part
    [48, "2d"],
    [49, "2d 1h"],
    [72, "3d"],
  ])("a day or more: formatHours(%f) -> %s", (input, expected) => {
    expect(formatHours(input)).toBe(expected);
  });

  it.each<[number]>([[-5], [-0.4], [Number.NaN], [Number.POSITIVE_INFINITY], [Number.NEGATIVE_INFINITY]])(
    "clamps non-positive / non-finite to 0h: formatHours(%f)",
    (input) => {
      expect(formatHours(input)).toBe("0h");
    },
  );

  it("formatDuration is an alias of formatHours", () => {
    expect(formatDuration).toBe(formatHours);
    expect(formatDuration(44)).toBe("1d 20h");
  });
});

describe("formatPercent", () => {
  it.each<[number, string]>([
    [0, "0%"],
    [72, "72%"],
    [72.4, "72%"],
    [72.6, "73%"],
    [100, "100%"],
    [150, "150%"],
  ])("formatPercent(%f) -> %s", (input, expected) => {
    expect(formatPercent(input)).toBe(expected);
  });

  it.each<[number]>([[Number.NaN], [Number.POSITIVE_INFINITY]])("non-finite -> 0%%: formatPercent(%f)", (input) => {
    expect(formatPercent(input)).toBe("0%");
  });
});

describe("ratioToPercent", () => {
  it.each<[number, string]>([
    [0, "0%"],
    [0.723, "72%"],
    [0.726, "73%"],
    [1, "100%"],
    [0.5, "50%"],
  ])("ratioToPercent(%f) -> %s", (input, expected) => {
    expect(ratioToPercent(input)).toBe(expected);
  });

  it("non-finite -> 0%", () => {
    expect(ratioToPercent(Number.NaN)).toBe("0%");
  });
});

describe("formatCredits", () => {
  it.each<[number, string]>([
    [0, "0c"],
    [950, "950c"],
    [1000, "1,000c"],
    [12400, "12,400c"],
    [1234567, "1,234,567c"],
    [-800, "-800c"],
    [-12400, "-12,400c"],
    [12400.6, "12,401c"], // rounds
  ])("formatCredits(%f) -> %s", (input, expected) => {
    expect(formatCredits(input)).toBe(expected);
  });

  it("deterministic regardless of locale", () => {
    // Hand-rolled grouping must always use a comma; never locale-dependent.
    expect(formatCredits(1000000)).toBe("1,000,000c");
  });
});

describe("formatSignedCredits", () => {
  it.each<[number, string]>([
    [0, "+0c"],
    [2100, "+2,100c"],
    [-800, "-800c"],
    [12400, "+12,400c"],
    [-12400, "-12,400c"],
  ])("formatSignedCredits(%f) -> %s", (input, expected) => {
    expect(formatSignedCredits(input)).toBe(expected);
  });
});
