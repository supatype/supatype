/**
 * `publicEnv("NAME")` reads one of the site's own public values from the page's
 * `window.__SUPATYPE_ENV__.env`, which `/supatype-env.js` sets beside the address and anon key.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { publicEnv } from "../src/index.js"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("publicEnv", () => {
  it("reads a value the page's script set", () => {
    vi.stubGlobal("__SUPATYPE_ENV__", { url: "https://api.example.com", anonKey: "k", env: { STRIPE_PK: "pk_live_1" } })
    expect(publicEnv("STRIPE_PK")).toBe("pk_live_1")
  })

  it("is undefined for a name the site did not set", () => {
    vi.stubGlobal("__SUPATYPE_ENV__", { url: "https://api.example.com", anonKey: "k", env: { A: "1" } })
    expect(publicEnv("B")).toBeUndefined()
  })

  it("is undefined before the script ran, and when the server answered with a fault", () => {
    expect(publicEnv("A")).toBeUndefined()
    vi.stubGlobal("__SUPATYPE_ENV__", { error: "public env unavailable" })
    expect(publicEnv("A")).toBeUndefined()
  })

  it("ignores a value that is not a string, and a name on the prototype", () => {
    vi.stubGlobal("__SUPATYPE_ENV__", { env: { N: 5, O: { x: 1 } } })
    expect(publicEnv("N")).toBeUndefined()
    expect(publicEnv("O")).toBeUndefined()
    expect(publicEnv("toString")).toBeUndefined()
    expect(publicEnv("constructor")).toBeUndefined()
  })

  it("reads the page again each call, since the script may load after the module", () => {
    expect(publicEnv("A")).toBeUndefined()
    vi.stubGlobal("__SUPATYPE_ENV__", { env: { A: "late" } })
    expect(publicEnv("A")).toBe("late")
  })
})
