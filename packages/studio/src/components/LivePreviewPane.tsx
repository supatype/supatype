import React, { useRef, useEffect, useMemo } from "react"
import { livePreviewMessage, originOf } from "@supatype/client/bindings"
import type { ModelConfig } from "../config.js"
import { ButtonLink, Card } from "./ui.js"

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

export function LivePreviewPane({ previewUrl, values, model, awaitingFirstSave }: LivePreviewPaneProps): React.ReactElement {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  usePostPreview(iframeRef, previewUrl, model.name, values)

  if (awaitingFirstSave) {
    // No "Open in new tab" either: it would lead to the same page saying the same thing.
    return (
      <PreviewCard>
        <div className="p-8 text-center text-sm text-muted-foreground">
          Save this {model.label.toLowerCase()} to preview it. The first save creates the record and
          its first draft, and the option to share a preview link appears with them.
        </div>
      </PreviewCard>
    )
  }

  return (
    <PreviewCard action={<ButtonLink size="xs" href={previewUrl} target="_blank" rel="noopener noreferrer">Open in new tab</ButtonLink>}>
      <iframe ref={iframeRef} src={previewUrl} className="block h-[350px] w-full border-0 lg:h-[500px]" title="Live preview" sandbox="allow-scripts allow-same-origin" />
    </PreviewCard>
  )
}

/** The pane's frame: a "Live Preview" bar, with an action at its end when there is one, over the body. */
function PreviewCard({ action, children }: { action?: React.ReactNode; children: React.ReactNode }): React.ReactElement {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-border bg-secondary px-3 py-2">
        <span className="text-xs font-semibold text-muted-foreground">Live Preview</span>
        {action}
      </div>
      {children}
    </Card>
  )
}
