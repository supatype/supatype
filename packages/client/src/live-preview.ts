import { isJsonObject } from "./json.js"

/**
 * The live preview protocol: what Studio posts to a framed preview page on every keystroke, and how
 * a binding reads it back. One copy, so the sender and the receivers cannot drift apart without
 * either side noticing.
 */

const LIVE_PREVIEW_MESSAGE = "supatype:live-preview"

/** What Studio posts: the model being edited and its unsaved form values. */
export interface LivePreviewMessage {
  type: typeof LIVE_PREVIEW_MESSAGE
  model: string
  data: Record<string, unknown>
}

/** The message Studio posts for `model`'s unsaved `data`. */
export function livePreviewMessage(model: string, data: Record<string, unknown>): LivePreviewMessage {
  return { type: LIVE_PREVIEW_MESSAGE, model, data }
}

/** The model and data a received message carries, when it is a live preview message at all. */
export function previewMessageOf(value: unknown): { model: unknown; data: unknown } | null {
  if (!isJsonObject(value) || value["type"] !== LIVE_PREVIEW_MESSAGE) return null
  return { model: value["model"], data: value["data"] }
}

/** The origin `url` loads from, resolved against `base` when given; null when it names none. */
export function originOf(url: string, base?: string): string | null {
  try {
    const { origin } = new URL(url, base)
    return origin === "null" ? null : origin
  } catch {
    return null
  }
}
