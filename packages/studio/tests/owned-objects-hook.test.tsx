// @vitest-environment jsdom
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ProjectProxy, SqlResult } from "../src/hooks/useProjectProxy.js"
import { ownedKey, useOwnedObjects, type OwnedObjects } from "../src/lib/owned-objects.js"
import { testProxy } from "./support.js"

/** useOwnedObjects: a ledger this role cannot read owns nothing; any other failure is reported, not hidden. */

let container: HTMLDivElement
let root: Root
let seen: OwnedObjects | null

function Probe({ proxy, schema = "public" }: { proxy: ProjectProxy; schema?: string }): null {
  seen = useOwnedObjects(proxy, schema)
  return null
}

function proxyAnswering(answer: () => Promise<{ rows: Record<string, unknown>[] }>): ProjectProxy {
  return testProxy({ metadata: async () => ({ rowCount: null, ...(await answer()) }) })
}

async function read(proxy: ProjectProxy): Promise<OwnedObjects> {
  await act(async () => root.render(<Probe proxy={proxy} />))
  await act(async () => {
    await Promise.resolve()
  })
  return seen!
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  seen = null
  container = document.createElement("div")
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
})

describe("useOwnedObjects()", () => {
  it("keys each row on its kind", async () => {
    const result = await read(proxyAnswering(async () => ({ rows: [{ kind: "index", parent: "posts", name: "i" }] })))
    expect(result.error).toBeNull()
    expect([...result.owned]).toEqual([ownedKey("index", "posts", "i")])
  })

  it("owns nothing, without an error, before there is a ledger", async () => {
    const result = await read(
      proxyAnswering(async () => {
        throw new Error('relation "_supatype.managed_objects" does not exist')
      }),
    )
    expect(result).toEqual({ owned: new Set(), error: null })
  })

  it("owns nothing by the ledger, without an error, for a role that may not read _supatype", async () => {
    // Studio's SQL role need not have USAGE on `_supatype`. The ledger is then as good as absent:
    // the badges fall back to the stamps an older engine wrote, and no banner blames the screen.
    const result = await read(
      proxyAnswering(async () => {
        throw new Error("ERROR: permission denied for schema _supatype")
      }),
    )
    expect(result).toEqual({ owned: new Set(), error: null })
  })

  it("owns nothing by the ledger, without an error, for a role that may use _supatype but not read the ledger", async () => {
    // USAGE on the schema and no SELECT on `managed_objects` leaves the role exactly as badly off
    // as one with no USAGE at all, so it falls back to the stamps the same way.
    const result = await read(
      proxyAnswering(async () => {
        throw new Error("permission denied for table managed_objects")
      }),
    )
    expect(result).toEqual({ owned: new Set(), error: null })
  })

  it("goes by the SQLSTATE the proxy passed on, not by the wording of the message", async () => {
    const result = await read(
      proxyAnswering(async () => {
        throw Object.assign(new Error("FEHLER: keine Berechtigung"), { code: "42501" })
      }),
    )
    expect(result).toEqual({ owned: new Set(), error: null })
  })

  it("reports any other failure rather than reading it as owning nothing", async () => {
    const result = await read(
      proxyAnswering(async () => {
        throw new Error('column "parent" does not exist')
      }),
    )
    expect(result.owned.size).toBe(0)
    expect(result.error).toBe('column "parent" does not exist')
  })

  it("reports a failure whose SQLSTATE says it is not about the ledger, whatever the message says", async () => {
    const result = await read(
      proxyAnswering(async () => {
        throw Object.assign(new Error("permission denied for schema _supatype"), { code: "42703" })
      }),
    )
    expect(result.error).toBe("permission denied for schema _supatype")
  })

  it("never shows the previous schema's objects while the next schema's are loading", async () => {
    let release: (result: SqlResult) => void = () => {}
    const proxy = proxyAnswering(async () => ({ rows: [] }))
    proxy.metadata = async (_name: string, params?: Record<string, unknown>) =>
      params?.["schema"] === "public"
        ? { rows: [{ kind: "index", parent: "posts", name: "i" }], rowCount: 1 }
        : new Promise<SqlResult>((resolve) => {
            release = resolve
          })
    expect([...(await read(proxy)).owned]).toEqual([ownedKey("index", "posts", "i")])

    await act(async () => root.render(<Probe proxy={proxy} schema="billing" />))
    // Loading billing: public's badge must not show on billing's objects.
    expect(seen!.owned.size).toBe(0)

    await act(async () => {
      release({ rows: [{ kind: "index", parent: "invoices", name: "j" }], rowCount: 1 })
      await Promise.resolve()
    })
    expect([...seen!.owned]).toEqual([ownedKey("index", "invoices", "j")])
  })
})
