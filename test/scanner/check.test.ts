import { describe, expect, it } from "vitest";
import { checkPost, maskSegment } from "../../src/core/secrets/check";
import { alnum } from "./fixtures";

const seg = (id: string, text: string) => ({ id, text, h: `h-${id}` });

describe("checkPost: context", () => {
  it("catches a token split across posts even when unrelated text comes first", () => {
    const token = ["gh", "p_", alnum(36)].join("");
    const r = checkPost(`${token.slice(20)} and that's all`, [seg("p1", "hello"), seg("p2", token.slice(0, 20))]);
    expect(r.hold).toBe(true);
    expect(r.rules).toContain("github-token");
    expect(r.contributing.map((c) => c.id)).toEqual(["p2"]);
  });

  it("catches a percent-encoded token split across posts with trailing text", () => {
    const token = ["sk", "_live_", alnum(24)].join("");
    const enc = [...token].map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    const r = checkPost(`${enc.slice(30)} trailing words`, [seg("p1", enc.slice(0, 30))]);
    expect(r.hold).toBe(true);
    expect(r.rules).toContain("stripe-secret-key");
  });

  it("does not hold a new post for a secret that sits entirely in an earlier post", () => {
    const token = ["sk", "_live_", alnum(24)].join("");
    const r = checkPost("thanks, rotating it now", [seg("p1", `oops ${token}`)]);
    expect(r.hold).toBe(false);
  });

  it("maps a percent-encoded match to a non-empty span for masking", () => {
    const token = ["sk", "_live_", alnum(24)].join("");
    const body = "key: " + [...token].map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    const r = checkPost(body, []);
    expect(r.hold).toBe(true);
    const parts = maskSegment(body, 0, r.matches);
    const masked = parts.filter((p) => p.masked);
    expect(masked.length).toBeGreaterThan(0);
    expect(parts.map((p) => p.text).join("")).not.toContain(body.slice(20, 60));
  });
});

describe("checkPost: CPU budget", () => {
  it("checks a 16 KB post against three 16 KB earlier posts well under 10 ms", async () => {
    const { realisticPost } = await import("./fixtures");
    const post = realisticPost();
    const context = [seg("p1", post), seg("p2", post), seg("p3", post)];
    const times: number[] = [];
    checkPost(post, context);
    for (let i = 0; i < 15; i++) {
      const t = performance.now();
      checkPost(post, context);
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    const ms = times[7]!;
    console.log(`checkPost with full context: ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(8);
  });
});
