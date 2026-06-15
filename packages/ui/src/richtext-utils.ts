import type { SerializedEditorState, SerializedLexicalNode } from "@supatype/types/lexical"

/** Lexical-compatible empty document (one empty paragraph). */
export function emptyRichTextDocument(): SerializedEditorState {
  return {
    root: {
      type: "root",
      format: "",
      indent: 0,
      version: 1,
      children: [
        {
          type: "paragraph",
          format: "",
          indent: 0,
          version: 1,
          children: [
            {
              type: "text",
              text: "",
              format: 0,
              style: "",
              mode: "normal",
              detail: 0,
              version: 1,
            },
          ],
        },
      ],
    },
  }
}

/** Plain sentence → minimal Lexical document (single paragraph). Not HTML — literal text only. */
export function stringToRichTextDocument(text: string): SerializedEditorState {
  return {
    root: {
      type: "root",
      format: "",
      indent: 0,
      version: 1,
      children: [
        {
          type: "paragraph",
          format: "",
          indent: 0,
          version: 1,
          children: [
            {
              type: "text",
              text,
              format: 0,
              style: "",
              mode: "normal",
              detail: 0,
              version: 1,
            },
          ],
        },
      ],
    },
  }
}

function isLexicalDocument(value: unknown): value is SerializedEditorState {
  return (
    typeof value === "object" &&
    value !== null &&
    "root" in value &&
    typeof (value as SerializedEditorState).root === "object"
  )
}

/**
 * Normalize a RichText default or seed value: Lexical object passthrough, JSON Lexical string, or plain string → Lexical.
 * Does not parse HTML.
 */
export function normalizeRichTextDefault(
  value: SerializedEditorState | string | null | undefined,
): SerializedEditorState | null {
  if (value === null || value === undefined) return null
  if (isLexicalDocument(value)) return value
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown
        if (isLexicalDocument(parsed)) return parsed
      } catch {
        // fall through — treat as plain text
      }
    }
    return stringToRichTextDocument(value)
  }
  return null
}

function collectText(node: SerializedLexicalNode): string {
  let out = ""
  if (typeof node.text === "string") out += node.text
  const children = node.children
  if (Array.isArray(children)) {
    for (const c of children) out += collectText(c as SerializedLexicalNode)
  }
  return out
}

/** True when the editor has no visible text (whitespace-only counts as empty). */
export function richTextIsEmpty(state: SerializedEditorState | null | undefined): boolean {
  if (state === null || state === undefined) return true
  return collectText(state.root).trim() === ""
}
