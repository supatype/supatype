import { useState, useEffect, useRef } from "react"

export interface UseLivePreviewOptions<TData> {
  /** The initial/server data to display when not in preview mode. */
  initialData: TData
  /** Optional model name filter — only accept preview data for this model. */
  model?: string
}

export interface UseLivePreviewResult<TData> {
  /** The current data — either live preview data or initial data. */
  data: TData
  /** Whether the component is currently receiving live preview updates. */
  isPreview: boolean
}

/**
 * Hook for receiving live preview updates from the Supatype admin panel.
 *
 * When the admin panel's edit view is open with Live Preview enabled,
 * it sends `postMessage` events with form data as the editor types.
 * This hook receives those events and returns the live data.
 *
 * @example
 * ```tsx
 * function BlogPost({ post }: { post: Post }) {
 *   const { data, isPreview } = useLivePreview({ initialData: post, model: "post" })
 *   return (
 *     <article>
 *       {isPreview && <div className="preview-badge">Preview</div>}
 *       <h1>{data.title}</h1>
 *       <div>{data.body}</div>
 *     </article>
 *   )
 * }
 * ```
 */
export function useLivePreview<TData>(
  opts: UseLivePreviewOptions<TData>,
): UseLivePreviewResult<TData> {
  const [previewData, setPreviewData] = useState<TData | null>(null)
  const initialRef = useRef(opts.initialData)
  initialRef.current = opts.initialData

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (typeof event.data !== "object" || event.data === null) return
      const msg = event.data as { type?: string; model?: string; data?: unknown }
      if (msg.type !== "supatype:live-preview") return
      if (opts.model && msg.model !== opts.model) return
      setPreviewData(msg.data as TData)
    }

    window.addEventListener("message", handler)
    return () => { window.removeEventListener("message", handler) }
  }, [opts.model])

  return {
    data: previewData ?? initialRef.current,
    isPreview: previewData !== null,
  }
}
