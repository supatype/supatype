import { describe, expect, it } from "vitest"
import {
  fetchPendingDraftIds,
  publishableLocales,
  publishingState,
  publishingSummary,
  WHOLE_RECORD,
  type LocaleState,
  type PublishingState,
  type RecordVersion,
} from "../src/lib/publishing.js"
import type { ModelVersionsConfig } from "../src/config.js"

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

describe("which records have an edit waiting", () => {
  const model = {
    tableName: "posts",
    primaryKey: "id",
    versions: versions({ versionsTable: "posts_versions" }),
  } as unknown as Parameters<typeof fetchPendingDraftIds>[1]

  function clientReturning(rows: unknown[]): Parameters<typeof fetchPendingDraftIds>[0] {
    const chain = {
      select: () => chain,
      in: () => chain,
      order: () => Promise.resolve({ data: rows, error: null }),
    }
    return { from: () => chain } as unknown as Parameters<typeof fetchPendingDraftIds>[0]
  }

  it("counts a record whose newest version is above the live one", async () => {
    const pending = await fetchPendingDraftIds(
      clientReturning([
        { record_id: "a", version: 2, published_locales: {} },
        { record_id: "a", version: 1, published_locales: { en: "2026-09-05T09:00:00Z" } },
      ]),
      model,
      ["a"],
    )
    expect([...pending]).toEqual(["a"])
  })

  it("counts a record that has never been published", async () => {
    // There is content nobody outside can see, which is the thing the badge is for.
    const pending = await fetchPendingDraftIds(
      clientReturning([{ record_id: "b", version: 1, published_locales: {} }]),
      model,
      ["b"],
    )
    expect([...pending]).toEqual(["b"])
  })

  it("leaves out a record whose newest version is the live one", async () => {
    const pending = await fetchPendingDraftIds(
      clientReturning([
        { record_id: "c", version: 2, published_locales: { en: "2026-09-05T09:00:00Z" } },
        { record_id: "c", version: 1, published_locales: {} },
      ]),
      model,
      ["c"],
    )
    expect(pending.size).toBe(0)
  })

  it("asks nothing of the server when there is nothing to ask about", async () => {
    // A list of fifty records should cost one request; an empty page should cost none.
    let called = false
    const client = {
      from: () => {
        called = true
        return { select: () => ({ in: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }) }
      },
    } as unknown as Parameters<typeof fetchPendingDraftIds>[0]
    expect((await fetchPendingDraftIds(client, model, [])).size).toBe(0)
    expect(called).toBe(false)
  })
})

describe("the state a shut publishing section stands for", () => {
  function state(locales: Record<string, LocaleState>): PublishingState {
    return { locales, newest: null } as unknown as PublishingState
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
