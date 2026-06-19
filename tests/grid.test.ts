import { describe, it, expect } from "vitest";
import {
  FLOOR,
  WALL,
  LOW_COVER,
  DEFAULT_PALETTE,
  makeGrid,
  cellIndex,
  inBounds,
  tileTypeAt,
  setTile,
  blocksMove,
  blocksSight,
  moveCost,
} from "../src/sim/grid";

describe("grid", () => {
  it("makeGrid produces the right dimensions filled with floor", () => {
    const g = makeGrid(4, 3);
    expect(g.width).toBe(4);
    expect(g.height).toBe(3);
    expect(g.cells.length).toBe(12);
    expect([...g.cells].every((c) => c === FLOOR)).toBe(true);
    expect(g.palette).toBe(DEFAULT_PALETTE);
  });

  it("makeGrid honours a non-zero fill index", () => {
    const g = makeGrid(2, 2, DEFAULT_PALETTE, WALL);
    expect([...g.cells].every((c) => c === WALL)).toBe(true);
  });

  it("cellIndex is row-major (y*width + x)", () => {
    const g = makeGrid(5, 5);
    expect(cellIndex(g, 0, 0)).toBe(0);
    expect(cellIndex(g, 2, 1)).toBe(7);
    expect(cellIndex(g, 4, 4)).toBe(24);
  });

  it("inBounds detects edges and out-of-bounds", () => {
    const g = makeGrid(3, 3);
    expect(inBounds(g, 0, 0)).toBe(true);
    expect(inBounds(g, 2, 2)).toBe(true);
    expect(inBounds(g, -1, 0)).toBe(false);
    expect(inBounds(g, 0, -1)).toBe(false);
    expect(inBounds(g, 3, 0)).toBe(false);
    expect(inBounds(g, 0, 3)).toBe(false);
  });

  it("tileTypeAt returns the palette entry or undefined when OOB", () => {
    const g = makeGrid(3, 3);
    expect(tileTypeAt(g, 1, 1)?.id).toBe("floor");
    expect(tileTypeAt(g, -1, 0)).toBeUndefined();
    expect(tileTypeAt(g, 3, 3)).toBeUndefined();
  });

  it("setTile mutates the cell; OOB is a no-op", () => {
    const g = makeGrid(3, 3);
    setTile(g, 1, 1, WALL);
    expect(tileTypeAt(g, 1, 1)?.id).toBe("wall");
    // out of bounds should not throw or grow the array
    setTile(g, 9, 9, WALL);
    expect(g.cells.length).toBe(9);
  });

  it("blocksMove: floor false, wall true, OOB true", () => {
    const g = makeGrid(3, 3);
    setTile(g, 1, 1, WALL);
    expect(blocksMove(g, 0, 0)).toBe(false);
    expect(blocksMove(g, 1, 1)).toBe(true);
    expect(blocksMove(g, -1, -1)).toBe(true);
  });

  it("low cover is walkable but transparent", () => {
    const g = makeGrid(3, 3);
    setTile(g, 1, 1, LOW_COVER);
    expect(blocksMove(g, 1, 1)).toBe(false);
    expect(blocksSight(g, 1, 1)).toBe(false);
    expect(moveCost(g, 1, 1)).toBe(6);
  });

  it("blocksSight: floor false, wall true, OOB true", () => {
    const g = makeGrid(3, 3);
    setTile(g, 2, 2, WALL);
    expect(blocksSight(g, 0, 0)).toBe(false);
    expect(blocksSight(g, 2, 2)).toBe(true);
    expect(blocksSight(g, 5, 5)).toBe(true);
  });

  it("moveCost: floor 4, wall Infinity, OOB Infinity", () => {
    const g = makeGrid(3, 3);
    setTile(g, 1, 1, WALL);
    expect(moveCost(g, 0, 0)).toBe(4);
    expect(moveCost(g, 1, 1)).toBe(Infinity);
    expect(moveCost(g, -1, 0)).toBe(Infinity);
  });
});
