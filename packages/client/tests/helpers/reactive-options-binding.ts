import { vi, describe, it, expect, afterEach } from "vitest"
import { createClient, type AnyDatabase, type SupatypeClient } from "@supatype/client"

/**
 * What every framework binding's query owes options that change after it mounted: a new read.
 *
 * 0.9.1 release test (FF25): the Vue, Svelte and Solid queries read their options once, so a
 * table whose sort, page or filter came from component state kept showing the first read. Each
 * suite mounts its binding with options held in its own reactive primitive (a ref or getter, a
 * store, a signal) and changes them through `change`. Not named `*.test.ts`, so vitest's default
 * include does not collect it as a suite.
 */
export interface ReadOptions {
  order: { column: string; ascending: boolean }
  limit?: number
  offset?: number
  filter?: Record<string, unknown>
  enabled?: boolean
}

export interface ReactiveOptionsProbe {
  change(options: ReadOptions): void
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** The query string of every read sent, decoded, in order. */
function sentReads(): string[] {
  const sent: string[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      sent.push(decodeURIComponent(url.search))
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } })
    }),
  )
  return sent
}

const FIRST: ReadOptions = { order: { column: "title", ascending: true }, limit: 2 }

export function describeReactiveOptionsBinding(
  name: string,
  mount: (client: SupatypeClient<AnyDatabase>, initial: ReadOptions) => ReactiveOptionsProbe,
  unmount: () => void,
): void {
  async function mounted(): Promise<{ probe: ReactiveOptionsProbe; sent: string[] }> {
    const sent = sentReads()
    const probe = mount(createClient<AnyDatabase>({ url: "http://localhost:9999", anonKey: "anon" }), FIRST)
    await settle()
    return { probe, sent }
  }

  describe(`${name} when its options change`, () => {
    afterEach(() => {
      unmount()
      vi.unstubAllGlobals()
    })

    it("reads once on mount", async () => {
      const { sent } = await mounted()
      expect(sent).toEqual(["?order=title.asc.nullslast&limit=2"])
    })

    it("reads again with the new sort", async () => {
      const { probe, sent } = await mounted()
      probe.change({ ...FIRST, order: { column: "title", ascending: false } })
      await settle()
      expect(sent.at(-1)).toBe("?order=title.desc.nullslast&limit=2")
      expect(sent).toHaveLength(2)
    })

    it("reads the next page as one limit and offset", async () => {
      const { probe, sent } = await mounted()
      probe.change({ ...FIRST, offset: 2 })
      await settle()
      expect(sent.at(-1)).toBe("?order=title.asc.nullslast&limit=2&offset=2")
    })

    it("reads again with the new filter", async () => {
      const { probe, sent } = await mounted()
      probe.change({ ...FIRST, filter: { status: "draft" } })
      await settle()
      expect(sent.at(-1)).toBe("?status=eq.draft&order=title.asc.nullslast&limit=2")
    })

    it("does not read while disabled, and reads when enabled again", async () => {
      const { probe, sent } = await mounted()
      probe.change({ ...FIRST, enabled: false })
      await settle()
      expect(sent).toHaveLength(1)
      probe.change({ ...FIRST, offset: 2 })
      await settle()
      expect(sent).toHaveLength(2)
      expect(sent.at(-1)).toBe("?order=title.asc.nullslast&limit=2&offset=2")
    })
  })
}
