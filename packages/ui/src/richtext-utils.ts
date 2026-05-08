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
