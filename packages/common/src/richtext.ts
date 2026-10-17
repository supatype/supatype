/**
 * Rich text rendering: prints a saved Lexical document as an HTML string.
 *
 * The document is walked once by `richTextTree` (shared with the React renderer); this module only
 * prints that tree, escaping every text run and attribute value.
 */

import { richTextTree, type RichTextAttributes, type RichTextChild, type RichTextContent, type RichTextStyle } from "./richtext-tree.js"

export {
  richTextTree,
  safeHref,
  type RichTextAttributes,
  type RichTextChild,
  type RichTextContent,
  type RichTextElement,
  type RichTextNode,
  type RichTextStyle,
  type RichTextTag,
} from "./richtext-tree.js"

const VOID_TAGS: ReadonlySet<string> = new Set(["br", "hr", "input"])

const ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char)
}

function styleText(style: RichTextStyle): string {
  return Object.entries(style)
    .map(([property, value]) => `${property.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${value}`)
    .join(";")
}

/** Every attribute an element can carry: the compiler checks this names each one, and no other. */
const ATTRIBUTE_NAMES: Readonly<Record<keyof RichTextAttributes, true>> = {
  href: true,
  rel: true,
  target: true,
  title: true,
  dir: true,
  start: true,
  value: true,
  class: true,
  type: true,
  checked: true,
  disabled: true,
  style: true,
}

function isAttributeName(name: string): name is keyof RichTextAttributes {
  return Object.hasOwn(ATTRIBUTE_NAMES, name)
}

function attributeText(attributes: RichTextAttributes): string {
  let out = ""
  // `Object.entries` types an interface's values as `any`; read each through its own key instead.
  for (const name of Object.keys(attributes).filter(isAttributeName)) {
    const value = attributes[name]
    if (value === undefined || value === false) continue
    if (value === true) out += ` ${name}`
    else if (typeof value === "object") out += ` ${name}="${escapeHtml(styleText(value))}"`
    else out += ` ${name}="${escapeHtml(String(value))}"`
  }
  return out
}

function printChild(child: RichTextChild): string {
  if (typeof child === "string") return escapeHtml(child)
  const attributes = attributeText(child.attributes)
  if (VOID_TAGS.has(child.tag)) return `<${child.tag}${attributes} />`
  return `<${child.tag}${attributes}>${child.children.map(printChild).join("")}</${child.tag}>`
}

/**
 * Print a saved Lexical document (the editor state, its root node, or a list of nodes) as HTML.
 * Null, undefined and anything else that is not a document print as an empty string.
 */
export function renderRichText(content: unknown): string {
  return richTextTree(content).map(printChild).join("")
}
