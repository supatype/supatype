import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { LivePreviewPane } from "../src/components/LivePreviewPane.js"
import { EditFormSidebar } from "../src/components/EditFormSidebar.js"
import type { ModelConfig } from "../src/config.js"

// The create screen used to embed the project's preview page for a record that had no row yet.
// That page answers, correctly for its own context, "this needs a preview link, open the post in
// Studio and use Share a preview" — and `SharePreview` mounts only in the edit view, because a link
// is minted against a row id. So the reader was told to use a control that was not on the screen,
// which reads as a missing feature rather than a missing save.

function model(): ModelConfig {
  return {
    name: "Post",
    label: "Post",
    labelPlural: "Posts",
    tableName: "posts",
    primaryKey: "id",
    fields: [],
    listColumns: [],
    searchFields: [],
  } as unknown as ModelConfig
}

const previewUrl = "http://localhost:3001/preview/hello"

describe("LivePreviewPane", () => {
  it("does not load the preview page for a record that has not been saved", () => {
    const html = renderToStaticMarkup(
      <LivePreviewPane
        previewUrl={previewUrl}
        values={{}}
        model={model()}
        awaitingFirstSave={true}
      />,
    )

    // No iframe: loading it is what produced the misleading advice in the first place.
    expect(html).not.toContain("<iframe")
    expect(html).not.toContain(previewUrl)
    // And no "Open in new tab", which would lead to the same page saying the same thing.
    expect(html).not.toContain("Open in new tab")
    expect(html).toContain("Save this post to preview it")
  })

  it("loads the preview page once the record exists", () => {
    const html = renderToStaticMarkup(
      <LivePreviewPane
        previewUrl={previewUrl}
        values={{}}
        model={model()}
        awaitingFirstSave={false}
      />,
    )

    expect(html).toContain("<iframe")
    expect(html).toContain(previewUrl)
    expect(html).toContain("Open in new tab")
    expect(html).not.toContain("Save this post to preview it")
  })
})

describe("where the preview is opened from", () => {
  // The preview used to sit beside the form permanently, which cost the form half its width on
  // every project that configured one. It opens from the sidebar now and slides in over the page.
  it("renders the opener in the sidebar when one is given", () => {
    const html = renderToStaticMarkup(
      <EditFormSidebar
        previewAction={<button type="button">Live preview</button>}
        metaFields={[]}
        values={{}}
        onChange={() => {}}
        primaryKey="id"
        currentLocale="en"
        defaultLocale="en"
        recordSyncKey="r1"
        saving={false}
        onSave={() => {}}
      />,
    )

    expect(html).toContain("Live preview")
    // The pane itself stays out of the page until the opener is used.
    expect(html).not.toContain("<iframe")
  })

  it("renders no opener for a model with no preview configured", () => {
    const html = renderToStaticMarkup(
      <EditFormSidebar
        metaFields={[]}
        values={{}}
        onChange={() => {}}
        primaryKey="id"
        currentLocale="en"
        defaultLocale="en"
        recordSyncKey="r1"
        saving={false}
        onSave={() => {}}
      />,
    )

    expect(html).not.toContain("Live preview")
  })
})
