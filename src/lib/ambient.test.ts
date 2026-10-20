import { describe, expect, it } from "vitest";
import { ambientFromPixels, GLOW_L, GLOW_MAX_C, rgbToOklch } from "./ambient";

function pixels(...colors: [number, number, number, number?][]): number[] {
  return colors.flatMap(([r, g, b, a = 255]) => [r, g, b, a]);
}

function parse(s: string | null) {
  const m = s?.match(/^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/);
  if (!m) throw new Error(`not an oklch colour: ${s}`);
  return { l: Number(m[1]), c: Number(m[2]), h: Number(m[3]) };
}

describe("rgbToOklch", () => {
  it("matches reference values", () => {
    const white = rgbToOklch([255, 255, 255]);
    expect(white.l).toBeCloseTo(1, 3);
    expect(white.c).toBeLessThan(0.001);
    const red = rgbToOklch([255, 0, 0]);
    expect(red.l).toBeCloseTo(0.628, 2);
    expect(red.c).toBeCloseTo(0.258, 2);
    expect(red.h).toBeCloseTo(29.2, 0);
  });
});

describe("ambientFromPixels", () => {
  it("returns null for grey or empty art", () => {
    expect(ambientFromPixels(pixels([128, 128, 128], [40, 40, 40], [220, 220, 220]))).toBeNull();
    expect(ambientFromPixels([])).toBeNull();
    expect(ambientFromPixels(pixels([255, 0, 0, 0]))).toBeNull();
  });

  it("lets the vivid subject win over a dark background", () => {
    const bg = Array.from({ length: 30 }, () => [12, 14, 16] as [number, number, number]);
    const subject = Array.from({ length: 6 }, () => [20, 160, 150] as [number, number, number]);
    const out = parse(ambientFromPixels(pixels(...bg, ...subject)));
    // teal subject: OKLCH hue around 180
    expect(out.h).toBeGreaterThan(165);
    expect(out.h).toBeLessThan(200);
  });

  it("keeps the glow at a fixed lightness with capped chroma", () => {
    const out = parse(ambientFromPixels(pixels([255, 0, 0], [250, 10, 0])));
    expect(out.l).toBe(GLOW_L);
    expect(out.c).toBeLessThanOrEqual(GLOW_MAX_C);
  });
});
