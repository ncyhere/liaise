import { describe, expect, it } from "vitest";
import { maskValue, scanText, ScanLimitError } from "../../src/core/secrets/scan";
import { adversarial, mustCatch, mustPass, realisticPost } from "./fixtures";

describe("secret scanner: corpus", () => {
  for (const [name, text, rule] of mustCatch()) {
    it(`catches ${name}`, () => {
      const found = scanText(text);
      expect(found.map((f) => f.rule), name).toContain(rule);
      for (const f of found) {
        expect(f.start).toBeGreaterThanOrEqual(0);
        expect(f.end).toBeLessThanOrEqual(text.length);
        expect(f.end).toBeGreaterThan(f.start);
      }
    });
  }
  for (const [name, text] of mustPass()) {
    it(`does not flag ${name}`, () => {
      expect(scanText(text).map((f) => `${f.rule}:${f.variant}`), name).toEqual([]);
    });
  }
});

describe("secret scanner: masking", () => {
  it("shows the first 6 and last 4 characters only", () => {
    expect(maskValue("sk-ant-api03-ABCDEFGHIJKLMNOP-wxyz")).toMatch(/^sk-ant•+wxyz$/);
    expect(maskValue("short")).toBe("•••••");
  });
});

function median(fn: () => void, runs = 15): number {
  const times: number[] = [];
  fn(); // warm up
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(runs / 2)]!;
}

describe("secret scanner: CPU budget", () => {
  it("scans a realistic 16 KB post well under 10 ms", () => {
    const post = realisticPost();
    const ms = median(() => scanText(post));
    console.log(`realistic 16 KB: ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(5);
  });

  it("scans a 16 KB post joined to three earlier 16 KB posts under 10 ms", () => {
    const joined = realisticPost().repeat(4);
    const ms = median(() => scanText(joined));
    console.log(`joined 64 KB: ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(10);
  });

  for (const [name, text] of adversarial()) {
    it(`stays linear on adversarial input: ${name}`, () => {
      const ms = median(() => {
        try {
          scanText(text);
        } catch (e) {
          if (!(e instanceof ScanLimitError)) throw e; // running out of budget is allowed: it holds the post
        }
      });
      console.log(`adversarial ${name}: ${ms.toFixed(2)} ms`);
      expect(ms).toBeLessThan(10);
    });
  }
});
