import { describe, expect, it } from "vitest";
import { nextBox, type Box } from "./spatial";

const box = (left: number, top: number, width = 100, height = 100): Box => ({ left, top, width, height });

// a 3-column grid of 100px cards with 10px gaps, plus a wide shelf strip under the first row
//   0 1 2
//   [shelf]
//   3 4 5
const grid = [box(0, 0), box(110, 0), box(220, 0), box(0, 250), box(110, 250), box(220, 250)];
const shelf = box(0, 115, 320, 120);

describe("arrow-key focus movement (SPEC §12)", () => {
  it("steps to the neighbour in each direction", () => {
    expect(nextBox(grid[1], grid, "left")).toBe(0);
    expect(nextBox(grid[1], grid, "right")).toBe(2);
    expect(nextBox(grid[1], grid, "down")).toBe(4);
    expect(nextBox(grid[4], grid, "up")).toBe(1);
  });

  it("stops at the edges", () => {
    expect(nextBox(grid[0], grid, "left")).toBe(-1);
    expect(nextBox(grid[2], grid, "right")).toBe(-1);
    expect(nextBox(grid[1], grid, "up")).toBe(-1);
    expect(nextBox(grid[5], grid, "down")).toBe(-1);
  });

  it("doesn't wrap left/right into another row", () => {
    const boxes = [...grid, box(330, 250)];
    expect(nextBox(grid[2], boxes, "right")).toBe(-1);
    expect(nextBox(grid[5], boxes, "right")).toBe(6);
  });

  it("prefers the card straight below over a closer diagonal one", () => {
    const boxes = [box(0, 0), box(0, 200), box(110, 120)];
    expect(nextBox(boxes[0], boxes, "down")).toBe(1);
  });

  it("goes down into a shelf strip under a row, and back up out of it", () => {
    const boxes = [...grid, shelf];
    expect(nextBox(grid[2], boxes, "down")).toBe(6);
    expect(nextBox(shelf, boxes, "down")).toBe(4);
    expect(nextBox(shelf, boxes, "up")).toBe(1);
  });

  it("ignores the box it starts from and returns -1 with nothing else", () => {
    expect(nextBox(grid[0], [grid[0]], "right")).toBe(-1);
    expect(nextBox(grid[0], [], "down")).toBe(-1);
  });
});
