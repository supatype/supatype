import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createRecord,
  duplicateValues,
  fetchRecordStates,
  liveRowLocaleStates,
  publishableLocales,
  publishingState,
  liveLocales,
  publishingSummary,
  WHOLE_RECORD,
  type LocaleState,
  type PublishingState,
  type RecordVersion,
} from "../src/lib/publishing.js"
import type { ModelVersionsConfig } from "../src/config.js"
import { testClient, testModel } from "./support.js"

// What the editor shows about a record is derived from its version rows rather than stored, because
// a stored answer is a second source of truth about publication and the rows already say it exactly.
// These pin the derivation, which is the only part with anything to get wrong.

function version(
  n: number,
  overrides: Partial<RecordVersion> = {},
): RecordVersion {
  return {
    id: `v${n}`,
    version: n,
    status: "draft",
    created_at: "2026-09-05T09:00:00Z",
    created_by: null,
    data: {},
    published_locales: {},
    scheduled_locales: {},
    ...overrides,
  }
}

const versions = (config: Partial<ModelVersionsConfig> = {}): ModelVersionsConfig => ({
  drafts: true,
  keep: 20,
  versionsTable: "posts_versions",
  localizedColumns: [],
  ...config,
})

describe("which locales a model publishes under", () => {
  it("is the single whole-record key when no column is localized", () => {
    // One shape for callers rather than two: a model with no translation still has a publish state,
    // it just has one of them.
    expect(publishableLocales(versions(), ["en", "fr"])).toEqual([WHOLE_RECORD])
  })

  it("is the project's locales when a column is", () => {
    expect(publishableLocales(versions({ localizedColumns: ["body"] }), ["en", "fr"])).toEqual([
      "en",
      "fr",
    ])
  })

  it("falls back to the whole record when the project declares no locales", () => {
    // A localized column with no `LocaleConfig` is a schema in an odd state, and publishing per
    // locale would mean publishing per nothing.
    expect(publishableLocales(versions({ localizedColumns: ["body"] }), [])).toEqual([WHOLE_RECORD])
  })
})

describe("what the history says about a record", () => {
  it("reports nothing live on a record that has never been published", () => {
    const state = publishingState([version(1)], [WHOLE_RECORD])
    expect(state.locales[WHOLE_RECORD]).toBe("absent")
    expect(state.hasPendingDraft).toBe(true)
  })

  it("reports live when the newest version is the published one", () => {
    const state = publishingState(
      [version(1, { published_locales: { [WHOLE_RECORD]: "2026-09-05T09:00:00Z" } })],
      [WHOLE_RECORD],
    )
    expect(state.locales[WHOLE_RECORD]).toBe("live")
    expect(state.hasPendingDraft).toBe(false)
  })

  it("reports pending when a newer version sits above the published one", () => {
    // The state the whole feature exists to make possible: something is live, and an edit to it is
    // waiting. A `status` column could not hold both.
    const state = publishingState(
      [version(2), version(1, { published_locales: { [WHOLE_RECORD]: "2026-09-05T09:00:00Z" } })],
      [WHOLE_RECORD],
    )
    expect(state.locales[WHOLE_RECORD]).toBe("pending")
    expect(state.hasPendingDraft).toBe(true)
  })

  it("reports scheduled when the pending edit has a time on it", () => {
    const state = publishingState(
      [
        version(2, { scheduled_locales: { [WHOLE_RECORD]: "2026-09-06T09:00:00Z" } }),
        version(1, { published_locales: { [WHOLE_RECORD]: "2026-09-05T09:00:00Z" } }),
      ],
      [WHOLE_RECORD],
    )
    expect(state.locales[WHOLE_RECORD]).toBe("scheduled")
  })

  it("answers per locale, so one can be live while another waits", () => {
    // Publishing merges one locale's keys and leaves the rest, so this is not a display convenience:
    // it is what the live row actually holds.
    const state = publishingState(
      [version(2), version(1, { published_locales: { en: "2026-09-05T09:00:00Z" } })],
      ["en", "fr"],
    )
    expect(state.locales["en"]).toBe("pending")
    expect(state.locales["fr"]).toBe("absent")
  })

  it("reads live from the version that claims the locale, not from the newest", () => {
    // Publishing a named version moves the claim, so an older version can be the live one. Reading
    // the newest instead would report an edit as live the moment it was saved.
    const state = publishingState(
      [version(3), version(2, { published_locales: { en: "2026-09-05T09:00:00Z" } }), version(1)],
      ["en"],
    )
    expect(state.locales["en"]).toBe("pending")
    expect(state.newest?.version).toBe(3)
  })

  it("reports live when the published version is also the newest, past older drafts", () => {
    const state = publishingState(
      [version(3, { published_locales: { en: "2026-09-05T09:00:00Z" } }), version(2), version(1)],
      ["en"],
    )
    expect(state.locales["en"]).toBe("live")
    expect(state.hasPendingDraft).toBe(false)
  })

  it("handles a record with no versions at all", () => {
    const state = publishingState([], [WHOLE_RECORD])
    expect(state.newest).toBeNull()
    expect(state.hasPendingDraft).toBe(false)
    expect(state.locales[WHOLE_RECORD]).toBe("absent")
  })
})

describe("what a list says each record is", () => {
  const model = testModel({
    versions: versions({ versionsTable: "posts_versions", localizedColumns: ["body"] }),
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** A real client whose version query is answered with `rows`, as PostgREST would. */
  function clientReturning(rows: unknown[]): ReturnType<typeof testClient> {
    vi.stubGlobal("fetch", async () => Response.json(rows))
    return testClient({ url: "http://localhost:8000" })
  }

  const LIVE = "2026-09-05T09:00:00Z"

  /** Record `a`'s state, its version query answered with `rows` and its live row being `live`. */
  async function stateOf(
    rows: unknown[],
    locales = ["en", "fr"],
    live: Record<string, unknown> = {},
  ): Promise<string | undefined> {
    const states = await fetchRecordStates(clientReturning(rows), model, [{ ...live, id: "a" }], locales)
    return states.get("a")
  }

  // Seeded rows, rows inserted through the API and rows saved before 0.7.0 have no version rows.
  // The list said nothing about them, which reads as live for a draft, and the editor called the
  // live ones "Not published". Their live row says what the read rule shows.
  const PAST = "2026-01-01T00:00:00Z"
  const FUTURE = "2999-01-01T00:00:00Z"

  it("reads a record with no history as live in the locales its published row holds", async () => {
    expect(await stateOf([], ["en", "fr"], { published_at: PAST, body: { en: "Hello", fr: "Salut" } })).toBe(
      "live",
    )
    expect(await stateOf([], ["en", "fr"], { published_at: PAST, body: { en: "Hello", fr: null } })).toBe(
      "partial",
    )
  })

  it("reads a record with no history and a future publish date as scheduled", async () => {
    expect(await stateOf([], ["en", "fr"], { published_at: FUTURE, body: { en: "Soon", fr: "Bientôt" } })).toBe(
      "scheduled",
    )
  })

  it("reads a record with no history and no publish date as never published", async () => {
    expect(await stateOf([], ["en", "fr"], { published_at: null, body: { en: "Not yet" } })).toBe("absent")
  })

  it("prefers the history over the live row when there is one", async () => {
    expect(
      await stateOf(
        [{ record_id: "a", version: 1, published_locales: {}, scheduled_locales: {} }],
        ["en", "fr"],
        { published_at: PAST, body: { en: "Hello", fr: "Salut" } },
      ),
    ).toBe("absent")
  })

  it("calls a record with an unpublished edit published, because it is", async () => {
    // This is the case that made the old badge wrong. The record's English is live and being read;
    // the list called it "Draft", which is what the editor calls a language nobody has ever seen.
    expect(
      await stateOf(
        [
          { record_id: "a", version: 2, published_locales: {}, scheduled_locales: {} },
          { record_id: "a", version: 1, published_locales: { en: LIVE, fr: LIVE }, scheduled_locales: {} },
        ],
      ),
    ).toBe("pending")
  })

  it("says partly published when one language is live and another never was", async () => {
    // The state a per-locale design needs and a per-locale word cannot say. Reported as "Not
    // published" before, over a post the public was reading in English.
    expect(
      await stateOf([
        { record_id: "a", version: 1, published_locales: { en: LIVE }, scheduled_locales: {} },
      ]),
    ).toBe("partial")
  })

  it("says not published when no language ever was", async () => {
    expect(
      await stateOf([
        { record_id: "a", version: 1, published_locales: {}, scheduled_locales: {} },
      ]),
    ).toBe("absent")
  })

  it("says live only when every language is current", async () => {
    expect(
      await stateOf([
        { record_id: "a", version: 1, published_locales: { en: LIVE, fr: LIVE }, scheduled_locales: {} },
      ]),
    ).toBe("live")
  })

  it("asks nothing of the server when there is nothing to ask about", async () => {
    // A list of fifty records should cost one request; an empty page should cost none.
    const sent = vi.fn(async () => Response.json([]))
    vi.stubGlobal("fetch", sent)
    const client = testClient({ url: "http://localhost:8000" })
    expect((await fetchRecordStates(client, model, [], ["en"])).size).toBe(0)
    expect(sent).not.toHaveBeenCalled()
  })
})

describe("what a live row says when there is no history", () => {
  const NOW = Date.parse("2026-10-19T12:00:00Z")
  const whole = versions()
  const localized = versions({ localizedColumns: ["abstract"] })

  it("is live, scheduled or a draft by its publish date", () => {
    const at = (published_at: string | null) =>
      liveRowLocaleStates({ published_at }, whole, [WHOLE_RECORD], NOW)[WHOLE_RECORD]
    expect(at("2026-10-15T15:49:15Z")).toBe("live")
    expect(at("2026-10-20T00:00:00Z")).toBe("scheduled")
    expect(at(null)).toBe("absent")
  })

  it("is live on a model with no publish date, since nothing in the row withholds it", () => {
    expect(liveRowLocaleStates({ title: "Always on" }, whole, [WHOLE_RECORD], NOW)).toEqual({
      [WHOLE_RECORD]: "live",
    })
  })

  it("counts only the locales the row holds content in", () => {
    const row = { published_at: "2026-10-15T15:49:15Z", abstract: { en: "Talk", fr: "", de: {} } }
    expect(liveRowLocaleStates(row, localized, ["en", "fr", "de", "es"], NOW)).toEqual({
      en: "live",
      fr: "absent",
      de: "absent",
      es: "absent",
    })
  })
})

describe("the state a shut publishing section stands for", () => {
  function state(locales: Record<string, LocaleState>): PublishingState {
    return { versions: [], newest: null, hasPendingDraft: false, locales }
  }

  // It returns a state rather than a label. The words live in one table beside the badge that
  // renders them, so the header and the rows six pixels below it cannot end up calling the same
  // state by two different names. They briefly did: "Edit" against "Edit waiting".

  it("says live only when every locale is", () => {
    // The header is the whole answer while the section is collapsed, so "live" has to mean all of
    // it. One unpublished translation under a green badge is the lie the per-locale design exists
    // to prevent.
    expect(publishingSummary(state({ en: "live", fr: "live" }), ["en", "fr"])).toBe("live")
    expect(publishingSummary(state({ en: "live", fr: "absent" }), ["en", "fr"])).not.toBe("live")
  })

  it("puts a waiting edit ahead of a schedule", () => {
    // A schedule is a decision somebody already made. An unpublished edit is one nobody has made
    // yet, so it is the thing worth surfacing when only one can be.
    expect(publishingSummary(state({ en: "pending", fr: "scheduled" }), ["en", "fr"])).toBe(
      "pending",
    )
  })

  it("reports a locale it has no state for as unpublished", () => {
    // The first render has no data yet. Failing towards "not published" is right: claiming a record
    // is live before asking is the one error that cannot be walked back.
    expect(publishingSummary(null, ["en"])).toBe("absent")
    expect(publishingSummary(state({}), ["en"])).toBe("absent")
  })

  it("does not call a record with no locales live", () => {
    // Vacuous truth would make `every` return true over an empty list and paint it green.
    expect(publishingSummary(state({}), [])).not.toBe("live")
  })
})

describe("partly published", () => {
  function state(locales: Record<string, LocaleState>): PublishingState {
    return { versions: [], newest: null, hasPendingDraft: false, locales }
  }

  it("outranks every other state, because every other word hides it", () => {
    // A post live in English with no French translation reported "Not published" while the public
    // was reading it, and "Edit waiting" once a revision existed. Both are true of some locale and
    // false of the record.
    expect(publishingSummary(state({ en: "live", fr: "absent" }), ["en", "fr"])).toBe("partial")
    expect(publishingSummary(state({ en: "pending", fr: "absent" }), ["en", "fr"])).toBe("partial")
    expect(publishingSummary(state({ en: "scheduled", fr: "absent" }), ["en", "fr"])).toBe("partial")
  })

  it("is not reached when every language has been published at some point", () => {
    // All published, one revised: that is an edit waiting, not a partial publication. Nothing is
    // missing from what a reader sees, it is merely older than the draft.
    expect(publishingSummary(state({ en: "live", fr: "pending" }), ["en", "fr"])).toBe("pending")
  })

  it("is not reached when nothing has ever been published", () => {
    expect(publishingSummary(state({ en: "absent", fr: "absent" }), ["en", "fr"])).toBe("absent")
  })

  it("names the languages a reader can and cannot reach", () => {
    // Pending counts as live: an older version of that language is being served. Scheduled does
    // not, because nothing of it is public yet.
    expect(liveLocales(state({ en: "live", fr: "absent" }), ["en", "fr"])).toEqual(["en"])
    expect(liveLocales(state({ en: "pending", fr: "absent" }), ["en", "fr"])).toEqual(["en"])
    expect(liveLocales(state({ en: "scheduled", fr: "absent" }), ["en", "fr"])).toEqual([])
  })
})

describe("creating a record", () => {
  // DR5: Studio inserted the live row with the whole form and drafted it after, so a record created
  // with English and German titles put the German live the moment English was published. A model
  // with drafts creates its record through `supatype.create_record`, which leaves every locale out of
  // the live row until it is published.

  interface Sent {
    path: string
    profile: string | null
    body: unknown
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** A real client whose requests are recorded and answered as PostgREST would. */
  function recordingClient(sent: Sent[]): ReturnType<typeof testClient> {
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null
      sent.push({ path, profile: new Headers(init?.headers).get("Content-Profile"), body })
      return path.endsWith("/rpc/create_record")
        ? Response.json({ record_id: "new-id", version: 1 })
        : Response.json([{ id: "row-id" }], { status: 201 })
    })
    return testClient({ url: "http://localhost:8000" })
  }

  const model = (drafts: boolean) =>
    testModel({ versions: drafts ? versions({ localizedColumns: ["title"] }) : null })

  const values = { title: { en: "Hello", de: "Hallo" } }

  it("creates a drafts model's record as its first draft, never inserting the live row", async () => {
    const sent: Sent[] = []
    const created = await createRecord(recordingClient(sent), model(true), values)
    expect(created).toEqual({ id: "new-id", error: null })
    expect(sent).toEqual([
      {
        path: "/rest/v1/rpc/create_record",
        profile: "supatype",
        body: { model_table: "posts", data: values },
      },
    ])
  })

  it("inserts the row of a model without drafts", async () => {
    const sent: Sent[] = []
    const created = await createRecord(recordingClient(sent), model(false), values)
    expect(created).toEqual({ id: "row-id", error: null })
    expect(sent).toEqual([{ path: "/rest/v1/posts", profile: null, body: values }])
  })
})

describe("duplicating a record", () => {
  // DR7: Duplicate copied `published_at`, so a copy of a published record was born with a publish
  // date. On a model whose read rule compares it, every column that is not localized was readable
  // before anyone published the copy.

  const original = {
    id: "original-id",
    title: { en: "Hello" },
    slug: "hello",
    published_at: "2026-09-05T09:00:00Z",
    created_at: "2026-09-01T09:00:00Z",
    updated_at: "2026-09-05T09:00:00Z",
  }

  it("leaves a drafts model's copy unpublished", () => {
    const model = testModel({ versions: versions() })
    expect(duplicateValues(model, original)).toEqual({ title: { en: "Hello" }, slug: "hello" })
  })

  it("keeps a published_at that is only a column on a model without drafts", () => {
    // Without drafts nothing publishes a record, so the column is data like any other.
    expect(duplicateValues(testModel(), original)).toEqual({
      title: { en: "Hello" },
      slug: "hello",
      published_at: "2026-09-05T09:00:00Z",
    })
  })
})
