/**
 * Lexical's serialized JSON: what a `RichText` column stores and what the editor in Studio and
 * `@supatype/ui` saves. `SerializedLexicalNode` is the loose shape every node shares; the specific
 * interfaces below describe the fields Lexical 0.43 writes for each node type those editors can
 * produce, so renderers and readers work from one definition.
 */

export interface SerializedLexicalNode {
  type: string
  version: number
  children?: SerializedLexicalNode[]
  [key: string]: unknown
}

export interface SerializedEditorState {
  root: SerializedLexicalNode
}

/** Block alignment, stored in an element node's `format` (empty when unset). */
export type ElementFormat = "" | "left" | "start" | "center" | "right" | "end" | "justify"

/** Fields every element node (root, paragraph, heading, quote, list, listitem, link, code) carries. */
export interface SerializedElementNode extends SerializedLexicalNode {
  children: SerializedLexicalNode[]
  direction: "ltr" | "rtl" | null
  format: ElementFormat
  indent: number
}

/**
 * A run of text. `format` is a bit set: bold 1, italic 2, strikethrough 4, underline 8, code 16,
 * subscript 32, superscript 64, highlight 128, lowercase 256, uppercase 512, capitalize 1024.
 * `tab` and `code-highlight` nodes are text nodes under their own type.
 */
export interface SerializedTextNode extends SerializedLexicalNode {
  type: "text" | "tab" | "code-highlight"
  text: string
  format: number
  detail: number
  mode: "normal" | "token" | "segmented"
  style: string
  highlightType?: string | null
}

export interface SerializedHeadingNode extends SerializedElementNode {
  type: "heading"
  tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
}

export interface SerializedListNode extends SerializedElementNode {
  type: "list"
  listType: "bullet" | "number" | "check"
  start: number
  tag: "ul" | "ol"
}

/** A list entry. A nested list is a `listitem` whose only child is a `list`. */
export interface SerializedListItemNode extends SerializedElementNode {
  type: "listitem"
  value: number
  checked?: boolean
}

/** `link` is set by an editor; `autolink` is detected from typed text and can be unlinked. */
export interface SerializedLinkNode extends SerializedElementNode {
  type: "link" | "autolink"
  url: string
  rel: string | null
  target: string | null
  title: string | null
  isUnlinked?: boolean
}

export interface SerializedCodeNode extends SerializedElementNode {
  type: "code"
  language?: string | null
}
