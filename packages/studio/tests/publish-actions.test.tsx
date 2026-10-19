// @vitest-environment jsdom
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PublishBar } from "../src/components/PublishBar.js"
import { EditView } from "../src/views/EditView.js"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { LocaleContext, type LocaleState } from "../src/hooks/useLocale.js"
import type { RecordEditor } from "../src/hooks/usePublishActions.js"
import type { ModelConfig } from "../src/config.js"
import { isJsonObject, safeParseJson } from "../src/lib/json.js"
import { testClient, testConfig, testField, testModel } from "./support.js"

/**
 * What each control in the publish panel asks the engine to do, read off the RPCs it sends.
 *
 * Each act is a `supatype.*` function, so the request names it: `/rpc/publish`, `/rpc/unpublish`
 * and so on. A control that sends the wrong one, or sends one before its question is answered, is
 * visible here as a list of calls.
 */

const PROXY = "http://localhost:8000/studio/proxy"
const CLIENT = testClient({ url: PROXY, token: "t" })
const LIVE_AT = "2026-10-15T15:49:00Z"
const DUE_AT = "2030-10-21T09:00:00Z"

const LOCALE: LocaleState = { currentLocale: "en", defaultLocale: "en", locales: [{ code: "en", label: "English" }], setLocale: () => {} }

const MODEL: ModelConfig = testModel({
  name: "post",
  publishable: true,
  fields: [testField({ name: "title" })],
  listColumns: ["title"],
  versions: { drafts: true, keep: 20, versionsTable: "posts_versions", localizedColumns: [] },
})

interface Rpc {
  fn: string
  body: Record<string, unknown>
}

interface Served {
  versions: Array<Record<string, unknown>>
  row: Record<string, unknown>
}

let rpcs: Rpc[] = []
let container: HTMLDivElement
let root: Root

function versionRow(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `v${String(n)}`,
    record_id: "r1",
    version: n,
    status: "draft",
    created_at: LIVE_AT,
    created_by: null,
    data: { title: `edit ${String(n)}` },
    published_locales: {},
    scheduled_locales: {},
    ...over,
  }
}

const live = (n: number): Record<string, unknown> =>
  versionRow(n, { status: "published", published_locales: { "*": LIVE_AT } })

function urlOf(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url
}

/** Answers reads from `served` and records every RPC, which all succeed. */
function serve(served: Served): void {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = urlOf(input)
    if (url.includes("/studio/auth/verify")) return Response.json({ role: "admin", seesDrafts: true })
    const rpc = /\/rpc\/(\w+)/.exec(url)
    if (rpc !== null) {
      const body = typeof init?.body === "string" ? safeParseJson(init.body) : null
      rpcs.push({ fn: rpc[1] ?? "", body: isJsonObject(body) ? body : {} })
      return Response.json({})
    }
    if (url.includes("/posts_versions")) return Response.json(served.versions)
    if (url.includes("/posts")) return Response.json([served.row])
    return Response.json([])
  })
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  rpcs = []
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

function editor(over: Partial<RecordEditor> = {}): RecordEditor {
  return {
    dirty: false,
    saving: false,
    savedAt: 0,
    onSave: () => {},
    persist: () => Promise.resolve("r1"),
    onChanged: () => {},
    ...over,
  }
}

/** The model on screen and the project's languages around it. */
interface Scope {
  model: ModelConfig
  locale: LocaleState
}

async function show(served: Served, ed: RecordEditor = editor(), scope: Scope = { model: MODEL, locale: LOCALE }): Promise<void> {
  serve(served)
  await act(async () =>
    root.render(
      <AdminClientContext.Provider value={CLIENT}>
        <LocaleContext.Provider value={scope.locale}>
          <PublishBar record={{ model: scope.model, recordId: "r1", title: "A post" }} editor={ed} seesDrafts onNavigate={() => {}} />
        </LocaleContext.Provider>
      </AdminClientContext.Provider>,
    ),
  )
  await settle()
}

function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === label || b.getAttribute("aria-label") === label,
  )
  if (found === undefined) throw new Error(`no button "${label}" in: ${document.body.textContent ?? ""}`)
  return found
}

async function click(label: string): Promise<void> {
  const target = button(label)
  await act(async () => {
    target.click()
  })
  await settle()
}

/** Opens the menu on the Publish button and lists what it offers. */
async function openMenu(): Promise<Element[]> {
  const trigger = button("More publishing actions")
  await act(async () => {
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
  })
  await settle()
  return [...document.body.querySelectorAll('[role="menuitem"]')]
}

/** Opens the menu on the Publish button and chooses `label`. */
async function choose(label: string): Promise<void> {
  const item = (await openMenu()).find((el) => (el.textContent ?? "").trim() === label)
  if (!(item instanceof HTMLElement)) throw new Error(`no menu item "${label}"`)
  await act(async () => {
    item.click()
  })
  await settle()
}

const fns = (): string[] => rpcs.map((r) => r.fn)

describe("the main button", () => {
  it("publishes a waiting edit", async () => {
    await show({ versions: [versionRow(2), live(1)], row: { id: "r1" } })
    await click("Publish changes")
    expect(fns()).toEqual(["publish"])
  })

  it("saves unsaved edits before publishing them", async () => {
    const persist = vi.fn(() => Promise.resolve("r1"))
    await show({ versions: [live(1)], row: { id: "r1" } }, editor({ dirty: true, persist }))
    await click("Publish changes")
    expect(persist).toHaveBeenCalledTimes(1)
    expect(fns()).toEqual(["publish"])
  })

  it("publishes a scheduled record now and takes the time off it", async () => {
    await show({ versions: [versionRow(1, { scheduled_locales: { "*": DUE_AT } })], row: { id: "r1" } })
    await click("Publish now")
    expect(fns()).toEqual(["publish", "unschedule_publish"])
  })

  it("records a history-less record's live row as its first version before publishing it", async () => {
    // Without the snapshot, publish refuses: "no version to publish ... Save a draft first".
    await show({ versions: [], row: { id: "r1", title: "Seeded", published_at: null } })
    await click("Publish")
    expect(fns()).toEqual(["create_draft", "publish"])
    expect(rpcs[0]?.body["data"]).toEqual({})
  })
})

describe("the menu", () => {
  it("asks before unpublishing, and unpublishes only once answered", async () => {
    await show({ versions: [live(1)], row: { id: "r1" } })
    await choose("Unpublish")
    expect(document.body.textContent).toContain('Unpublish "A post"?')
    expect(fns()).toEqual([])
    await click("Unpublish")
    expect(fns()).toEqual(["unpublish"])
  })

  it("does nothing when the unpublish question is cancelled", async () => {
    await show({ versions: [live(1)], row: { id: "r1" } })
    await choose("Unpublish")
    await click("Cancel")
    expect(fns()).toEqual([])
    expect(document.body.textContent).not.toContain('Unpublish "A post"?')
  })

  it("keeps a history-less record's content when unpublishing it", async () => {
    // On a localized model unpublish strips the locale's keys from the live row, which for a record
    // with no history is the only copy. The snapshot keeps it as a draft.
    await show({ versions: [], row: { id: "r1", title: "Seeded", published_at: LIVE_AT } })
    await choose("Unpublish")
    await click("Unpublish")
    expect(fns()).toEqual(["create_draft", "unpublish"])
  })

  it("discards a waiting edit by restoring the published version", async () => {
    const onChanged = vi.fn()
    await show({ versions: [versionRow(2), live(1)], row: { id: "r1" } }, editor({ onChanged }))
    await choose("Discard changes")
    expect(fns()).toEqual([])
    await click("Discard changes")
    expect(fns()).toEqual(["restore_version"])
    expect(rpcs[0]?.body["version"]).toBe(1)
    // The form re-reads, so what it shows is what is published again.
    expect(onChanged).toHaveBeenCalledWith("r1", true)
  })

  it("keeps the single Unpublish on a model that publishes as a whole", async () => {
    await show({ versions: [live(1)], row: { id: "r1" } })
    const offered = (await openMenu()).map((el) => (el.textContent ?? "").trim())
    expect(offered).toContain("Unpublish")
    expect(offered.some((label) => label.includes("languages") || label.includes(" in "))).toBe(false)
  })

  it("cancels a schedule without publishing", async () => {
    await show({ versions: [versionRow(1, { scheduled_locales: { "*": DUE_AT } })], row: { id: "r1" } })
    await choose("Cancel schedule")
    expect(fns()).toEqual(["unschedule_publish"])
  })
})

describe("a localized record", () => {
  const LOCALIZED: Scope = {
    model: { ...MODEL, versions: { drafts: true, keep: 20, versionsTable: "posts_versions", localizedColumns: ["title"] } },
    locale: { ...LOCALE, locales: [{ code: "en", label: "English" }, { code: "fr", label: "French" }] },
  }
  const both = (n: number): Record<string, unknown> =>
    versionRow(n, { status: "published", published_locales: { en: LIVE_AT, fr: LIVE_AT } })
  const items = async (): Promise<string[]> => (await openMenu()).map((el) => (el.textContent ?? "").trim())

  it("publishes only the language on screen from the main button", async () => {
    await show({ versions: [versionRow(1)], row: { id: "r1" } }, editor(), LOCALIZED)
    await click("Publish in English")
    expect(fns()).toEqual(["publish"])
    expect(rpcs[0]?.body["locales"]).toEqual(["en"])
  })

  it("follows the language the editor is showing", async () => {
    const french: Scope = { ...LOCALIZED, locale: { ...LOCALIZED.locale, currentLocale: "fr" } }
    await show({ versions: [versionRow(2), both(1)], row: { id: "r1" } }, editor(), french)
    await click("Publish changes in French")
    expect(rpcs[0]?.body["locales"]).toEqual(["fr"])
  })

  it("publishes every language as plain Publish when the language on screen is not one of the record's", async () => {
    const german: Scope = { ...LOCALIZED, locale: { ...LOCALIZED.locale, currentLocale: "de" } }
    await show({ versions: [versionRow(1)], row: { id: "r1" } }, editor(), german)
    await click("Publish")
    expect(fns()).toEqual(["publish"])
    expect(rpcs[0]?.body).not.toHaveProperty("locales")
  })

  it("keeps a label the project chose for a code no language name exists for", async () => {
    const custom: Scope = { ...LOCALIZED, locale: { ...LOCALIZED.locale, currentLocale: "xx-internal", locales: [{ code: "en", label: "EN" }, { code: "xx-internal", label: "Internal" }] } }
    await show({ versions: [versionRow(1)], row: { id: "r1" } }, editor(), custom)
    expect(button("Publish in Internal").disabled).toBe(false)
  })

  it("publishes every language from the menu", async () => {
    await show({ versions: [versionRow(1)], row: { id: "r1" } }, editor(), LOCALIZED)
    await choose("Publish all languages")
    expect(fns()).toEqual(["publish"])
    expect(rpcs[0]?.body).not.toHaveProperty("locales")
  })

  it("lists the per-language acts in place of the single Unpublish", async () => {
    await show({ versions: [both(1)], row: { id: "r1" } }, editor(), LOCALIZED)
    const offered = await items()
    expect(offered).toEqual(expect.arrayContaining(["Publish all languages", "Unpublish in English", "Unpublish all languages"]))
    expect(offered).not.toContain("Unpublish")
  })

  it("asks before unpublishing the language on screen, then withdraws only it", async () => {
    await show({ versions: [both(1)], row: { id: "r1" } }, editor(), LOCALIZED)
    await choose("Unpublish in English")
    expect(document.body.textContent).toContain('Unpublish "A post" in English?')
    expect(fns()).toEqual([])
    await click("Unpublish in English")
    expect(fns()).toEqual(["unpublish"])
    expect(rpcs[0]?.body["locales"]).toEqual(["en"])
  })

  it("asks before unpublishing every language, then withdraws them all", async () => {
    await show({ versions: [both(1)], row: { id: "r1" } }, editor(), LOCALIZED)
    await choose("Unpublish all languages")
    expect(document.body.textContent).toContain('Unpublish "A post" in all languages?')
    expect(fns()).toEqual([])
    await click("Unpublish all languages")
    expect(fns()).toEqual(["unpublish"])
    expect(rpcs[0]?.body).not.toHaveProperty("locales")
  })

  it("does nothing when the one-language question is cancelled", async () => {
    await show({ versions: [both(1)], row: { id: "r1" } }, editor(), LOCALIZED)
    await choose("Unpublish in English")
    await click("Cancel")
    expect(fns()).toEqual([])
  })

  it("records a history-less record's live row before publishing one language of it", async () => {
    await show({ versions: [], row: { id: "r1", title: { en: "Seeded" }, published_at: null } }, editor(), LOCALIZED)
    await click("Publish in English")
    expect(fns()).toEqual(["create_draft", "publish"])
    expect(rpcs[1]?.body["locales"]).toEqual(["en"])
  })
})

describe("the edit view", () => {
  async function view(model: ModelConfig): Promise<string> {
    serve({ versions: [live(1)], row: { id: "r1", title: "A post" } })
    await act(async () =>
      root.render(
        <AdminConfigContext.Provider value={testConfig({ models: [model] })}>
          <AdminClientContext.Provider value={CLIENT}>
            <LocaleContext.Provider value={LOCALE}>
              <EditView model={model} recordId="r1" onNavigate={() => {}} />
            </LocaleContext.Provider>
          </AdminClientContext.Provider>
        </AdminConfigContext.Provider>,
      ),
    )
    await settle()
    return container.textContent ?? ""
  }

  it("gives a drafts model the publish panel and Save draft, and no second Save", async () => {
    const text = await view(MODEL)
    expect(text).toContain("Save draft")
    expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Save")).toBe(false)
  })

  it("keeps a plain Save for a model without drafts", async () => {
    const text = await view({ ...MODEL, versions: null })
    expect(text).not.toContain("Save draft")
    expect(text).not.toContain("Status")
    expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Save")).toBe(true)
  })
})
