import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    test: {
      projects: [
        {
          // Everything that touches the Worker runs inside the Workers runtime.
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./wrangler.jsonc" },
              miniflare: {
                bindings: {
                  TEST_MIGRATIONS: migrations,
                  PUBLIC_ORIGIN: "http://localhost:8787",
                  DEV_LOGIN: "unsafe-local-only",
                  HASH_KEY: "test-hash-key-0123456789abcdef0123456789abcdef",
                },
              },
            }),
          ],
          test: { name: "workers", include: ["test/*.test.ts"], setupFiles: ["./test/setup.ts"], testTimeout: 20000 },
        },
        {
          // The secret scanner is pure TypeScript. It runs in Node too, where CPU time can be
          // measured (the Workers runtime freezes timers during computation).
          test: { name: "scanner", include: ["test/scanner/**/*.test.ts"], environment: "node", testTimeout: 20000 },
        },
      ],
    },
  };
});
