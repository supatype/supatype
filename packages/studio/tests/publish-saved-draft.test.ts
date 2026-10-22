import { describe, expect, it } from "vitest"
import { describePanel } from "../src/lib/publish-panel.js"
import { liveRowState, WHOLE_RECORD } from "../src/lib/publishing.js"

/**
 * C24 (fresh-test): an editor's Save draft did happen, but the panel went on saying the record was
 * live with nothing to publish, because the history the panel reads did not show the editor the
 * version they had just saved. Admin and developer, who can read it, saw "Changed" and "Publish
 * changes". A draft saved from this form now says so whatever the history read returns.
 */

const LIVE = liveRowState({ published_at: "2026-10-15T15:49:00Z" }, { drafts: true, keep: 20, versionsTable: "post_versions", localizedColumns: [] }, [WHOLE_RECORD])

function panel(savedDraft: boolean): ReturnType<typeof describePanel> {
  return describePanel({ locales: [WHOLE_RECORD], state: LIVE, dirty: false, savedDraft, creating: false, editing: null, labels: {} })
}

describe("a draft saved from the form", () => {
  it("shows Changed and offers to publish it, though the history read does not show it", () => {
    const saved = panel(true)
    expect(saved.changed).toBe(true)
    expect(saved.primary).toEqual({ label: "Publish changes", disabled: false })
    expect(saved.note).toBe("The live site still shows the published version.")
  })

  it("leaves a record nobody saved here as live with nothing to publish", () => {
    expect(panel(false).changed).toBe(false)
    expect(panel(false).primary.disabled).toBe(true)
  })
})
