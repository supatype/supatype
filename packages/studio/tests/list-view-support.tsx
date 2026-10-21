import React, { act } from "react"
import { MemoryRouter } from "react-router-dom"
import { vi } from "vitest"
import type { ModelConfig } from "../src/config.js"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { LocaleContext } from "../src/hooks/useLocale.js"
import { ListView } from "../src/views/ListView.js"
import { mount, settle, testClient, testConfig, unmount } from "./support.js"

/** A model's list, rendered against a REST stub that records every row read it is sent. */
export interface ListHarness {
  container: HTMLElement
  /** Every read of the model's table, in order. */
  reads: URL[]
  unmount: () => void
}

const PROXY = "http://localhost:8000/studio/proxy"

/** The `order` parameter of the latest read, or null when it sent none. */
export function lastOrder(reads: readonly URL[]): string | null {
  return reads.at(-1)?.searchParams.get("order") ?? null
}

/**
 * `model`'s list, whose every read answers with `rows`: none by default. Settling runs on the
 * virtual clock, so the file calls `isolateEachTest()`, which also unmounts it after the test.
 */
export async function renderList(model: ModelConfig, rows: Array<Record<string, unknown>> = []): Promise<ListHarness> {
  const reads: URL[] = []
  vi.stubGlobal("fetch", async (raw: string) => {
    const url = new URL(raw)
    if (url.pathname.endsWith(`/rest/v1/${model.tableName}`)) reads.push(url)
    return Response.json(rows)
  })
  const view = await mount(
    <MemoryRouter>
      <AdminConfigContext.Provider value={testConfig({ models: [model] })}>
        <AdminClientContext.Provider value={testClient({ url: PROXY, token: "token" })}>
          <LocaleContext.Provider value={{ currentLocale: "en", setLocale: () => undefined, locales: [], defaultLocale: "en" }}>
            <ListView model={model} onNavigate={() => undefined} />
          </LocaleContext.Provider>
        </AdminClientContext.Provider>
      </AdminConfigContext.Provider>
    </MemoryRouter>,
  )
  await settle()
  return { container: view.container, reads, unmount: () => { unmount(view); vi.unstubAllGlobals() } }
}

/** The column header reading `label`, clicked. */
export async function clickHeader(container: HTMLElement, label: string): Promise<void> {
  const header = Array.from(container.querySelectorAll("th")).find((th) => th.textContent?.startsWith(label))
  if (!header) throw new Error(`no "${label}" column header`)
  await act(async () => header.click())
  await settle()
}
