import React, { useRef, useEffect, useMemo } from "react"
import { livePreviewMessage, originOf } from "@supatype/client/bindings"
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

/**
 * Send the form's values to the framed preview page on every change.
 *
 * Addressed to the preview page's origin, not "*": the values are unsaved, and whatever else the
 * frame might hold by the time a message is sent (a redirect, a navigation) must not receive them.
 */
function usePostPreview(
  iframeRef: React.RefObject<HTMLIFrameElement | null>,
  previewUrl: string,
  modelName: string,
  values: Record<string, unknown>,
): void {
  // Null when rendered on a server: there is no frame to post to and no origin to resolve against.
  const targetOrigin = useMemo(
    () => (typeof window === "undefined" ? null : originOf(previewUrl, window.location.href)),
    [previewUrl],
  )
  useEffect(() => {
    const target = iframeRef.current?.contentWindow
    if (!target || targetOrigin === null) return
    target.postMessage(livePreviewMessage(modelName, values), targetOrigin)
  }, [iframeRef, values, modelName, targetOrigin])
}

export function LivePreviewPane({
  previewUrl,
  values,
  model,
  awaitingFirstSave,
}: LivePreviewPaneProps): React.ReactElement {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  usePostPreview(iframeRef, previewUrl, model.name, values)

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
