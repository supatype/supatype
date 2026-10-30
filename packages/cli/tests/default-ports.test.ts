import { describe, expect, it } from "vitest"
import * as ports from "../src/project-config.js"
import { serveCommand } from "./support/serve-command.js"

/**
 * Decision D4 (local test round 3): `functions serve` and the native server both defaulted to
 * 54321, Supabase's port, so a Supabase user trying Supatype hit a held port at once. Both now sit
 * in Supatype's own range, below the gateway's 18473, where `dev` walks upward for each further
 * project, so neither meets a gateway either.
 */
const SUPABASE_API_PORT = 54321

/** The default `functions serve --port` takes. */
function functionsServePortDefault(): unknown {
  return serveCommand()?.options.find((o) => o.long === "--port")?.defaultValue
}

describe("default local ports", () => {
  it("puts the native server in Supatype's range, below the gateway's", () => {
    expect(ports.NATIVE_SERVER_PORT).not.toBe(SUPABASE_API_PORT)
    expect(ports.NATIVE_SERVER_PORT).toBeGreaterThanOrEqual(18400)
    expect(ports.NATIVE_SERVER_PORT).toBeLessThan(ports.COMPOSE_DEV_KONG_PORT)
  })

  it("serves functions on a port of Supatype's own, apart from the server's", () => {
    expect(functionsServePortDefault()).toBe(String(ports.FUNCTIONS_SERVE_PORT))
    expect(ports.FUNCTIONS_SERVE_PORT).not.toBe(SUPABASE_API_PORT)
    expect(ports.FUNCTIONS_SERVE_PORT).not.toBe(ports.NATIVE_SERVER_PORT)
    expect(ports.FUNCTIONS_SERVE_PORT).toBeLessThan(ports.COMPOSE_DEV_KONG_PORT)
  })
})
