import type { D1Migration } from "cloudflare:test";
import type { Env as LiaiseEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends LiaiseEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
