import React, { useRef, useEffect } from "react"
import type { ModelConfig } from "../config.js"

interface LivePreviewPaneProps {
  /** Where this record renders, resolved by the view so both halves agree on one address. */
  previewUrl: string
  values: Record<string, unknown>
  model: ModelConfig
}

export function LivePreviewPane({ previewUrl, values, model }: LivePreviewPaneProps): React.ReactElement {
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
