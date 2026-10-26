// @vitest-environment jsdom
import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { PublishBar } from "../src/components/PublishBar.js"
import { EditView } from "../src/views/EditView.js"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { LocaleContext, type LocaleState } from "../src/hooks/useLocale.js"
import type { RecordEditor } from "../src/hooks/usePublishActions.js"
import type { ModelConfig } from "../src/config.js"
import { isJsonObject, safeParseJson } from "../src/lib/json.js"
import { press } from "./dialog-support.js"
import { act, button, elementOf, findButton, isolateEachTest, mount, settle, testClient, testConfig, testField, testModel } from "./support.js"

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
  /** The message a DELETE is refused with. Deletes succeed when unset. */
  deleteRefusal?: string
  /** An RPC refused with this error body (a 400); every other RPC succeeds. */
  rpcRefusal?: { fn: string; body: Record<string, unknown> }
}

let rpcs: Rpc[] = []
/** The URL of every DELETE sent, in order. */
let deletes: string[] = []

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
    if (url.includes("/studio/auth/verify")) return Response.json({ role: "admin", seesDrafts: true, permissions: { write: true } })
    const rpc = /\/rpc\/(\w+)/.exec(url)
    if (rpc !== null) {
      const body = typeof init?.body === "string" ? safeParseJson(init.body) : null
      rpcs.push({ fn: rpc[1] ?? "", body: isJsonObject(body) ? body : {} })
      const refused = served.rpcRefusal
      return refused !== undefined && refused.fn === rpc[1] ? Response.json(refused.body, { status: 400 }) : Response.json({})
    }
    if (init?.method === "DELETE") {
      deletes.push(url)
      const refusal = served.deleteRefusal
      return refusal === undefined ? Response.json([]) : Response.json({ message: refusal }, { status: 403 })
    }
    if (url.includes("/posts_versions")) return Response.json(served.versions)
    if (url.includes("/posts")) return Response.json([served.row])
    return Response.json([])
  })
}

isolateEachTest()

beforeEach(() => {
  rpcs = []
  deletes = []
})

/** Mounts `ui` as this test's view and lets it settle; returns the container it rendered into. */
async function render(ui: React.ReactElement): Promise<HTMLElement> {
  const { container } = await mount(ui)
  await settle()
  return container
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
  await render(
    <AdminClientContext.Provider value={CLIENT}>
      <LocaleContext.Provider value={scope.locale}>
        <PublishBar record={{ model: scope.model, recordId: "r1", title: "A post" }} editor={ed} seesDrafts onNavigate={() => {}} />
      </LocaleContext.Provider>
    </AdminClientContext.Provider>,
  )
}

/** Opens the menu on the Publish button and lists what it offers. */
async function openMenu(): Promise<Element[]> {
  const trigger = button(document.body, "More publishing actions")
  await act(() => {
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
  })
  await settle()
  return [...document.body.querySelectorAll('[role="menuitem"]')]
}

/** Opens the menu on the Publish button and chooses `label`. */
async function choose(label: string): Promise<void> {
  const item = (await openMenu()).find((el) => (el.textContent ?? "").trim() === label)
  if (!(item instanceof HTMLElement)) throw new Error(`no menu item "${label}"`)
  await act(() => item.click())
  await settle()
}

const fns = (): string[] => rpcs.map((r) => r.fn)

describe("the main button", () => {
  it("publishes a waiting edit", async () => {
    await show({ versions: [versionRow(2), live(1)], row: { id: "r1" } })
    await press("Publish changes")
    expect(fns()).toEqual(["publish"])
  })

  it("saves unsaved edits before publishing them", async () => {
    const persist = vi.fn(() => Promise.resolve("r1"))
    await show({ versions: [live(1)], row: { id: "r1" } }, editor({ dirty: true, persist }))
    await press("Publish changes")
    expect(persist).toHaveBeenCalledTimes(1)
    expect(fns()).toEqual(["publish"])
  })

  it("publishes a scheduled record now and takes the time off it", async () => {
    await show({ versions: [versionRow(1, { scheduled_locales: { "*": DUE_AT } })], row: { id: "r1" } })
    await press("Publish now")
    expect(fns()).toEqual(["publish", "unschedule_publish"])
  })

  it("records a history-less record's live row as its first version before publishing it", async () => {
    // Without the snapshot, publish refuses: "no version to publish ... Save a draft first".
    await show({ versions: [], row: { id: "r1", title: "Seeded", published_at: null } })
    await press("Publish")
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
    await press("Unpublish")
    expect(fns()).toEqual(["unpublish"])
  })

  it("does nothing when the unpublish question is cancelled", async () => {
    await show({ versions: [live(1)], row: { id: "r1" } })
    await choose("Unpublish")
    await press("Cancel")
    expect(fns()).toEqual([])
    expect(document.body.textContent).not.toContain('Unpublish "A post"?')
  })

  it("keeps a history-less record's content when unpublishing it", async () => {
    // On a localized model unpublish strips the locale's keys from the live row, which for a record
    // with no history is the only copy. The snapshot keeps it as a draft.
    await show({ versions: [], row: { id: "r1", title: "Seeded", published_at: LIVE_AT } })
    await choose("Unpublish")
    await press("Unpublish")
    expect(fns()).toEqual(["create_draft", "unpublish"])
  })

  it("discards a waiting edit by restoring the published version", async () => {
    const onChanged = vi.fn()
    await show({ versions: [versionRow(2), live(1)], row: { id: "r1" } }, editor({ onChanged }))
    await choose("Discard changes")
    expect(fns()).toEqual([])
    await press("Discard changes")
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
    await press("Publish in English")
    expect(fns()).toEqual(["publish"])
    expect(rpcs[0]?.body["locales"]).toEqual(["en"])
  })

  it("follows the language the editor is showing", async () => {
    const french: Scope = { ...LOCALIZED, locale: { ...LOCALIZED.locale, currentLocale: "fr" } }
    await show({ versions: [versionRow(2), both(1)], row: { id: "r1" } }, editor(), french)
    await press("Publish changes in French")
    expect(rpcs[0]?.body["locales"]).toEqual(["fr"])
  })

  it("publishes every language as plain Publish when the language on screen is not one of the record's", async () => {
    const german: Scope = { ...LOCALIZED, locale: { ...LOCALIZED.locale, currentLocale: "de" } }
    await show({ versions: [versionRow(1)], row: { id: "r1" } }, editor(), german)
    await press("Publish")
    expect(fns()).toEqual(["publish"])
    expect(rpcs[0]?.body).not.toHaveProperty("locales")
  })

  it("keeps a label the project chose for a code no language name exists for", async () => {
    const custom: Scope = { ...LOCALIZED, locale: { ...LOCALIZED.locale, currentLocale: "xx-internal", locales: [{ code: "en", label: "EN" }, { code: "xx-internal", label: "Internal" }] } }
    await show({ versions: [versionRow(1)], row: { id: "r1" } }, editor(), custom)
    expect(button(document.body, "Publish in Internal").disabled).toBe(false)
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
    await press("Unpublish in English")
    expect(fns()).toEqual(["unpublish"])
    expect(rpcs[0]?.body["locales"]).toEqual(["en"])
  })

  it("asks before unpublishing every language, then withdraws them all", async () => {
    await show({ versions: [both(1)], row: { id: "r1" } }, editor(), LOCALIZED)
    await choose("Unpublish all languages")
    expect(document.body.textContent).toContain('Unpublish "A post" in all languages?')
    expect(fns()).toEqual([])
    await press("Unpublish all languages")
    expect(fns()).toEqual(["unpublish"])
    expect(rpcs[0]?.body).not.toHaveProperty("locales")
  })

  it("does nothing when the one-language question is cancelled", async () => {
    await show({ versions: [both(1)], row: { id: "r1" } }, editor(), LOCALIZED)
    await choose("Unpublish in English")
    await press("Cancel")
    expect(fns()).toEqual([])
  })

  it("records a history-less record's live row before publishing one language of it", async () => {
    await show({ versions: [], row: { id: "r1", title: { en: "Seeded" }, published_at: null } }, editor(), LOCALIZED)
    await press("Publish in English")
    expect(fns()).toEqual(["create_draft", "publish"])
    expect(rpcs[1]?.body["locales"]).toEqual(["en"])
  })
})

describe("the edit view", () => {
  async function view(model: ModelConfig): Promise<HTMLElement> {
    serve({ versions: [live(1)], row: { id: "r1", title: "A post" } })
    return render(
      <AdminConfigContext.Provider value={testConfig({ models: [model] })}>
        <AdminClientContext.Provider value={CLIENT}>
          <LocaleContext.Provider value={LOCALE}>
            <EditView model={model} recordId="r1" onNavigate={() => {}} />
          </LocaleContext.Provider>
        </AdminClientContext.Provider>
      </AdminConfigContext.Provider>,
    )
  }

  it("gives a drafts model the publish panel and Save draft, and no second Save", async () => {
    const container = await view(MODEL)
    const text = container.textContent ?? ""
    expect(text).toContain("Save draft")
    expect(findButton(container, "Save")).toBeUndefined()
  })

  it("keeps a plain Save for a model without drafts", async () => {
    const container = await view({ ...MODEL, versions: null })
    const text = container.textContent ?? ""
    expect(text).not.toContain("Save draft")
    expect(text).not.toContain("Status")
    expect(findButton(container, "Save")).toBeDefined()
  })

  /** The edit view on record r1, with what it navigates to. */
  async function editing(served: Served): Promise<string[]> {
    const went: string[] = []
    serve(served)
    await render(
      <AdminConfigContext.Provider value={testConfig({ models: [MODEL] })}>
        <AdminClientContext.Provider value={CLIENT}>
          <LocaleContext.Provider value={LOCALE}>
            <EditView model={MODEL} recordId="r1" onNavigate={(path) => { went.push(path) }} />
          </LocaleContext.Provider>
        </AdminClientContext.Provider>
      </AdminConfigContext.Provider>,
    )
    return went
  }

  const dialogText = (): string => document.body.querySelector('[role="alertdialog"]')?.textContent ?? ""

  it("asks before deleting, naming the record, and deletes only once answered", async () => {
    const went = await editing({ versions: [live(1)], row: { id: "r1", title: "A post" } })
    await press("Delete")
    expect(dialogText()).toContain('Delete "A post"?')
    expect(dialogText()).toContain("It is deleted for good. This cannot be undone.")
    expect(deletes).toEqual([])
    await press("Delete", elementOf(document.body, '[role="alertdialog"]', HTMLElement))
    expect(deletes).toHaveLength(1)
    expect(went).toEqual(["/models/post"])
  })

  it("does nothing when the delete question is cancelled", async () => {
    const went = await editing({ versions: [live(1)], row: { id: "r1", title: "A post" } })
    await press("Delete")
    await press("Cancel")
    expect(deletes).toEqual([])
    expect(went).toEqual([])
    expect(dialogText()).toBe("")
  })

  it("stays on the record and says why when the delete is refused", async () => {
    const went = await editing({ versions: [live(1)], row: { id: "r1", title: "A post" }, deleteRefusal: "permission denied for table posts" })
    await press("Delete")
    await press("Delete", elementOf(document.body, '[role="alertdialog"]', HTMLElement))
    expect(went).toEqual([])
    expect(document.body.querySelector('[data-ui="error-banner-message"]')?.textContent).toBe("You do not have permission to make this change.")
    expect(document.body.querySelector('[data-ui="error-banner"] details')?.textContent).toContain("permission denied for table posts")
  })
})

/**
 * Publishing copies the draft into the live row, where the table's NOT NULL holds. A draft saved
 * with a required field empty is refused there, and the panel showed Postgres's sentence for it.
 */
describe("a publish the database refuses", () => {
  it("says which field is missing, in words", async () => {
    const notNull = { code: "23502", message: 'null value in column "title" of relation "posts" violates not-null constraint' }
    await show({ versions: [versionRow(2), live(1)], row: { id: "r1" }, rpcRefusal: { fn: "publish", body: notNull } })
    await press("Publish changes")
    const alert = document.body.querySelector('[aria-label="Publishing"] [role="alert"]')?.textContent
    expect(alert).toBe("title is required")
  })
})
