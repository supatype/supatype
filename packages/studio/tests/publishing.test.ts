import { describe, expect, it } from "vitest"
import {
  publishableLocales,
  publishingState,
  WHOLE_RECORD,
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
