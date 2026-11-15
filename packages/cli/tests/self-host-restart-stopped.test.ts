import { describe, expect, it } from "vitest"
import { restartRefusal } from "../src/stack-running.js"

/**
 * `self-host compose restart <service>` recreates one service with `up --no-deps`. Run where the
 * stack was not running (a folder whose project name matched a stack already taken down), it
 * created that one container alone, plus a database volume and networks for a stack that did not
 * exist, holding this folder's mount (0.9.3 end-to-end test). A stack with no containers is now
 * refused, naming `up`.
 */
describe("restart on a stack that is not running", () => {
  it("is refused, naming the stack and how to start it", () => {
    const refusal = restartRefusal("functions-worker", "supatype-app", () => "")
    expect(refusal).toContain("supatype-app")
    expect(refusal).toContain("supatype self-host compose up")
  })

  it("goes ahead when the stack has containers", () => {
    expect(restartRefusal("functions-worker", "supatype-app", () => "3f2a\n9c1b\n")).toBeNull()
  })

  it("goes ahead when Docker cannot be asked, as the compose call will say why", () => {
    expect(restartRefusal("functions-worker", "supatype-app", () => null)).toBeNull()
  })
})

/**
 * The database joins the `functions-db` network only when SUPATYPE_FUNCTIONS_DB_URL names it, and
 * only when `up` recreates it. Set after `up` and followed by `restart functions-worker`, the
 * worker came back with the URL while db stayed off the network, so every function using
 * ctx.dbUrl failed with `getaddrinfo ENOTFOUND db`. restart now says to run `up`.
 */
describe("restarting the worker after functions were given the database", () => {
  it("says to run up when db is not on the functions network yet", async () => {
    const { functionsNetworkNote } = await import("../src/stack-running.js")
    const note = functionsNetworkNote("functions-worker", "supatype-app", true, ["supatype-app_default"])
    expect(note).toContain("supatype self-host compose up")
    expect(note).toContain("ENOTFOUND db")
  })

  it("says nothing once db is on it, for another service, or with no database URL", async () => {
    const { functionsNetworkNote } = await import("../src/stack-running.js")
    expect(functionsNetworkNote("functions-worker", "supatype-app", true, ["supatype-app_default", "supatype-app_functions-db"])).toBeNull()
    expect(functionsNetworkNote("storage", "supatype-app", true, ["supatype-app_default"])).toBeNull()
    expect(functionsNetworkNote("functions-worker", "supatype-app", false, ["supatype-app_default"])).toBeNull()
    expect(functionsNetworkNote("functions-worker", "supatype-app", true, null)).toBeNull()
  })
})
