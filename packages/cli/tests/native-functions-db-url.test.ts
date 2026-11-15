import { describe, expect, it } from "vitest"
import { nativeServerDotEnvLayer } from "../src/native-dev-env.js"
import { validateProjectConfig } from "../src/project-config.js"

/**
 * `ctx.dbUrl` is off unless the operator sets SUPATYPE_FUNCTIONS_DB_URL. The worker reads
 * SUPATYPE_DB_URL and falls back to DATABASE_URL. Natively it inherits the server's environment,
 * where DATABASE_URL is the auth service's admin URL, so every function was handed a superuser
 * connection that bypasses row rules and masking, and SUPATYPE_FUNCTIONS_DB_URL was ignored.
 * The last layer now names SUPATYPE_DB_URL itself, empty unless .env sets the documented key.
 */

const config = validateProjectConfig(
  { project: { name: "demo" }, server: { mode: "dev" }, app: { mode: "none" }, database: { provider: "native" } },
  "supatype.config.ts",
)
const layer = (dotEnv: Record<string, string>): Record<string, string> =>
  nativeServerDotEnvLayer({ dotEnv, config, denoPort: 54330 })

describe("the functions database URL on native dev", () => {
  it("is empty when .env sets none, so the worker never falls back to the admin DATABASE_URL", () => {
    expect(layer({ DATABASE_URL: "postgresql://supatype_admin:x@localhost:5432/demo" })["SUPATYPE_DB_URL"]).toBe("")
  })

  it("is SUPATYPE_FUNCTIONS_DB_URL from .env, as the compose file passes it", () => {
    const url = "postgresql://functions_reader:x@localhost:5432/demo"
    expect(layer({ SUPATYPE_FUNCTIONS_DB_URL: url })["SUPATYPE_DB_URL"]).toBe(url)
  })
})
