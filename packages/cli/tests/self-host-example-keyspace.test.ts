import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { cacheProvider } from "../src/cache-provider.js"
import { loadConfig } from "../src/config.js"

const EXAMPLE = resolve(import.meta.dirname, "../../../examples/self-host")

describe("the self-host example", () => {
  it("serves its cache from pg_keyspace, as a default stack does, despite pinning postgres", () => {
    expect(cacheProvider(loadConfig(EXAMPLE))).toBe("pg_keyspace")
  })
})
