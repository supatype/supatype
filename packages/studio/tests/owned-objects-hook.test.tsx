// @vitest-environment jsdom
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ProjectProxy } from "../src/hooks/useProjectProxy.js"
import { ownedKey, useOwnedObjects, type OwnedObjects } from "../src/lib/owned-objects.js"

/** useOwnedObjects: a missing ledger owns nothing; any other failure is reported, not hidden. */

let container: HTMLDivElement
let root: Root
let seen: OwnedObjects | null

function Probe({ proxy }: { proxy: ProjectProxy }): null {
  seen = useOwnedObjects(proxy, "public")
  return null
}

function proxyAnswering(answer: () => Promise<{ rows: Record<string, unknown>[] }>): ProjectProxy {
  return { sql: answer } as unknown as ProjectProxy
}

async function read(proxy: ProjectProxy): Promise<OwnedObjects> {
  await act(async () => root.render(<Probe proxy={proxy} />))
  await act(async () => {
    await Promise.resolve()
  })
  return seen!
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
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

  it("reports any other failure rather than reading it as owning nothing", async () => {
    const result = await read(
      proxyAnswering(async () => {
        throw new Error("permission denied for table managed_objects")
      }),
    )
    expect(result.owned.size).toBe(0)
    expect(result.error).toBe("permission denied for table managed_objects")
  })
})
