import { describe, expect, it } from "vitest"
import { renderSelfHostCompose } from "../src/self-host-compose.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"
import { DENO_RELEASE_PIN } from "../src/release-pins.js"
import { POSTGREST_HOOK_ACTOR_ENV, SERVER_MIN_FOR_HOOK_ACTOR, postgrestHookActorEnv } from "../src/hook-actor.js"
import { compareVersions } from "../src/engine-floor.js"
import { defaultComponentVersion } from "../src/release-images.js"

/**
 * After-hooks read writes from the change log, which records rows and not who wrote them. PostgREST
 * runs the server's `auth.emit_hook_actor()` before each request, in the request's transaction, so
 * the listener can tell an API write (and its caller) from a write made in SQL.
 *
 * Only a server that creates that function may be named: PostgREST calls the pre-request function on
 * every request, and one that does not exist fails them all.
 */
function config(server: string | undefined): SupatypeProjectConfig {
  return {
    project: { name: "acme" },
    database: { provider: "docker" },
    server: { mode: "dev" },
    app: { mode: "none" },
    versions: { engine: "0.4.2", postgres: "17.2", deno: DENO_RELEASE_PIN, ...(server !== undefined && { server }) },
  }
}

/** One service's block, ending at the next service or at a top-level key. */
function serviceBlock(compose: string, name: string): string {
  const lines = compose.split("\n")
  const start = lines.indexOf(`  ${name}:`)
  if (start === -1) return ""
  const after = lines.slice(start + 1).findIndex((l) => /^ {2}[a-z][a-z0-9-]*:$/.test(l) || /^[a-z]/.test(l))
  return lines.slice(start, after === -1 ? lines.length : start + 1 + after).join("\n")
}

const LINE = "PGRST_DB_PRE_REQUEST: auth.emit_hook_actor"

describe("PostgREST marks each API write with its caller", () => {
  it("names the server's pre-request function", () => {
    expect(POSTGREST_HOOK_ACTOR_ENV).toEqual({ PGRST_DB_PRE_REQUEST: "auth.emit_hook_actor" })
  })

  it("runs it on a compose stack whose server creates the function", () => {
    expect(serviceBlock(renderSelfHostCompose(config(SERVER_MIN_FOR_HOOK_ACTOR)), "postgrest")).toContain(LINE)
    expect(serviceBlock(renderSelfHostCompose(config("local")), "postgrest")).toContain(LINE)
  })

  it("leaves it out for a server pinned below the release that creates it", () => {
    expect(serviceBlock(renderSelfHostCompose(config("v2.2.2")), "postgrest")).not.toContain("PGRST_DB_PRE_REQUEST")
    expect(postgrestHookActorEnv(config("2.2.2"))).toEqual({})
  })

  it("follows the server this CLI pins when the project pins none", () => {
    const pinned = defaultComponentVersion("server") ?? "0.0.0"
    const expected = compareVersions(pinned, SERVER_MIN_FOR_HOOK_ACTOR) >= 0 ? POSTGREST_HOOK_ACTOR_ENV : {}
    expect(postgrestHookActorEnv(config(undefined))).toEqual(expected)
  })
})
