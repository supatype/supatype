"use client"

import { useState, useEffect, useRef, useContext } from "react"
import { isCallerValue, previewMessageOf } from "@supatype/client/bindings"
import { SupatypeContext } from "./context.js"
import { studioUrlsKey, trustedStudioOrigins, warnRefusedOrigin, type StudioOrigins } from "./live-preview-message.js"

export interface UseLivePreviewOptions<TData> {
  /** The initial/server data to display when not in preview mode. */
  initialData: TData
  /**
   * Optional model name filter, only accept preview data for this model. The name as the schema
   * declares it (`"Post"`), which is what Studio sends, not the table name.
   */
  model?: string
  /**
   * Where Studio is served, as a URL or origin, or a list of them. Only messages from these origins
   * are applied.
   *
   * Defaults to the origin of the `<SupatypeProvider>` client's URL, since Studio is served at
   * `/studio/` on the project's API URL. Set it when Studio lives elsewhere, or when this page has
   * no provider: with neither, every preview message is ignored.
   */
  studioOrigin?: StudioOrigins
}

export interface UseLivePreviewResult<TData> {
  /** The current data: either live preview data or initial data. */
  data: TData
  /** Whether the component is currently receiving live preview updates. */
  isPreview: boolean
}

/**
 * Hook for receiving live preview updates from the Supatype admin panel.
 *
 * When the admin panel's edit view is open with Live Preview enabled,
 * it sends `postMessage` events with form data as the editor types.
 * This hook receives those events and returns the live data. A message is applied only when it
 * comes from the window framing this page, at a Studio origin (see `studioOrigin`).
 *
 * @example
 * ```tsx
 * function BlogPost({ post }: { post: Post }) {
 *   const { data, isPreview } = useLivePreview({ initialData: post, model: "Post" })
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
  const urlsKey = studioUrlsKey(opts.studioOrigin, useContext(SupatypeContext)?.url)
  const warned = useRef(new Set<string>())

  useEffect(() => {
    const trusted = trustedStudioOrigins(urlsKey)
    // Applied only when the framing window sent it, from an origin Studio is served at.
    const handler = (event: MessageEvent): void => {
      const msg = previewMessageOf(event.data)
      if (msg === null || event.source !== window.parent) return
      if (!trusted.has(event.origin)) return warnRefusedOrigin(event.origin, warned.current)
      if (opts.model && msg.model !== opts.model) return
      if (isCallerValue<TData>(msg.data)) setPreviewData(msg.data)
    }
    window.addEventListener("message", handler)
    return () => { window.removeEventListener("message", handler) }
  }, [opts.model, urlsKey])

  return { data: previewData ?? initialRef.current, isPreview: previewData !== null }
}
