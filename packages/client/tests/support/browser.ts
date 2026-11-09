import { vi, type Mock } from "vitest"

/** What a stubbed browser records: navigations, address-bar rewrites, and its localStorage. */
export interface StubbedBrowser {
  assign: Mock<(url: string) => void>
  replaceState: Mock<(state: unknown, unused: string, url: string) => void>
  store: Map<string, string>
}

/**
 * A browser at `href`, with a localStorage holding `stored`. Not named `*.test.ts`, so vitest's
 * default include does not collect it as a suite.
 */
export function stubBrowser(href: string, stored: Record<string, string> = {}): StubbedBrowser {
  const store = new Map(Object.entries(stored))
  const assign = vi.fn<(url: string) => void>()
  const replaceState = vi.fn<(state: unknown, unused: string, url: string) => void>()
  vi.stubGlobal("window", {
    location: { href, protocol: "https:", assign },
    history: { state: null, replaceState },
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
      removeItem: (k: string) => { store.delete(k) },
    },
  })
  return { assign, replaceState, store }
}
