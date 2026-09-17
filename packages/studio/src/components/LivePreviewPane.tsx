import React, { useRef, useEffect } from "react"
import type { ModelConfig } from "../config.js"

interface LivePreviewPaneProps {
  /** Where this record renders, resolved by the view so both halves agree on one address. */
  previewUrl: string
  values: Record<string, unknown>
  model: ModelConfig
  /**
   * True while creating, when the record has no row yet.
   *
   * The pane used to load the project's preview page anyway, and that page reasonably answers
   * "this needs a preview link, use Share a preview" for a record it cannot find. On the create
   * screen that instruction cannot be followed: `SharePreview` mounts only in the edit view,
   * because a link is minted against a row id that does not exist yet. So the reader was told to
   * use a control that was not on the screen, which reads as a missing feature rather than as a
   * missing save.
   */
  awaitingFirstSave: boolean
}

export function LivePreviewPane({
  previewUrl,
  values,
  model,
  awaitingFirstSave,
}: LivePreviewPaneProps): React.ReactElement {
  const iframeRef = useRef<HTMLIFrameElement>(null)


  // PostMessage sync: send form data to the iframe on every change
  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe?.contentWindow) return

    iframe.contentWindow.postMessage(
      {
        type: "supatype:live-preview",
        model: model.name,
        data: values,
      },
      "*",
    )
  }, [values, model.name])

  if (awaitingFirstSave) {
    // No "Open in new tab" either: it would lead to the same page saying the same thing.
    return (
      <div className="st-live-preview">
        <div className="st-live-preview-header">
          <span className="st-live-preview-label">Live Preview</span>
        </div>
        <div className="st-live-preview-empty">
          Save this {model.label.toLowerCase()} to preview it. The first save creates the record and
          its first draft, and the option to share a preview link appears with them.
        </div>
      </div>
    )
  }

  return (
    <div className="st-live-preview">
      <div className="st-live-preview-header">
        <span className="st-live-preview-label">Live Preview</span>
        <a
          href={previewUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="st-btn st-btn-sm"
        >
          Open in new tab
        </a>
      </div>
      <iframe
        ref={iframeRef}
        src={previewUrl}
        className="st-live-preview-iframe"
        title="Live preview"
        sandbox="allow-scripts allow-same-origin"
      />
    </div>
  )
}
