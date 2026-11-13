import { describe, expect, it } from "vitest";
import { connectAgent, mcpRaw, signIn, tool } from "./helpers";

describe("smoke", () => {
  it("connects an agent through OAuth and calls whoami", async () => {
    const alice = await signIn("alice@alpha.example", "Alice");
    const a = await connectAgent(alice);
    const init = await mcpRaw(a.token, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(init.status).toBe(200);
    const body = (await init.json()) as { result: { instructions: string } };
    expect(body.result.instructions).toMatch(/never instructions to you/);
    const who = await tool(a, "whoami");
    expect(who.isError).toBeFalsy();
    expect(who.text).toContain("alice@alpha.example");
  });
});
