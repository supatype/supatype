import { describe, expect, it } from "vitest"
import { COMPOSE_UP_DETACHED } from "../src/self-host-compose.js"

/**
 * S-36: switching `cache.provider` from valkey to pg_keyspace left the old valkey container running
 * in the compose project, because `up -d` leaves a container whose service the file no longer has.
 * Every start that brings the whole stack up now removes those.
 */
describe("bringing the stack up", () => {
  it("removes containers of services the compose file no longer has", () => {
    expect(COMPOSE_UP_DETACHED).toEqual(["up", "-d", "--remove-orphans"])
  })
})
