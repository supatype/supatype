/**
 * The one walker over saved Lexical JSON. It turns a document into a small element tree that each
 * renderer (the HTML string here, React elements in @supatype/react) prints without knowing
 * anything about Lexical, so every renderer shows the same thing for the same document.
 *
 * Saved JSON is untrusted: it came out of a database column that any API client can write. Every
 * field is read with a type check, a link's URL is only emitted for a safe scheme, and a node type
 * this walker does not know still shows its words rather than vanishing.
 */

import type {
  ElementFormat,
  SerializedEditorState,
  SerializedHeadingNode,
  SerializedLexicalNode,
  SerializedListNode,
} from "@supatype/types/lexical"

export type RichTextNode = SerializedLexicalNode

/** Anything a `RichText` column holds: the editor state, its root node, or a list of nodes. */
export type RichTextContent = SerializedEditorState | RichTextNode | readonly RichTextNode[] | null | undefined

export type RichTextTag =
  | "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "blockquote" | "ul" | "ol" | "li" | "a" | "br"
  | "hr" | "pre" | "code" | "strong" | "em" | "s" | "u" | "sub" | "sup" | "mark" | "span" | "input"

export interface RichTextStyle {
  textAlign?: string
  paddingInlineStart?: string
  textTransform?: string
  listStyleType?: string
}

export interface RichTextAttributes {
  href?: string
  rel?: string
  target?: string
  title?: string
  dir?: "ltr" | "rtl"
  start?: number
  value?: number
  class?: string
  type?: "checkbox"
  checked?: boolean
  disabled?: boolean
  style?: RichTextStyle
}

export interface RichTextElement {
  tag: RichTextTag
  attributes: RichTextAttributes
  children: RichTextChild[]
}

export type RichTextChild = RichTextElement | string

type ListType = SerializedListNode["listType"]

interface WalkContext {
  inCode: boolean
  listType: ListType | null
}

type NodeRenderer = (node: RichTextNode, context: WalkContext) => RichTextChild[]

const TOP: WalkContext = { inCode: false, listType: null }

/** Text format bits, innermost wrapper first. */
const FORMAT_TAGS: ReadonlyArray<readonly [bit: number, tag: RichTextTag]> = [
  [16, "code"], [32, "sub"], [64, "sup"], [128, "mark"], [8, "u"], [4, "s"], [2, "em"], [1, "strong"],
]

const TEXT_TRANSFORMS: ReadonlyArray<readonly [bit: number, value: string]> = [
  [256, "lowercase"], [512, "uppercase"], [1024, "capitalize"],
]

type HeadingTag = SerializedHeadingNode["tag"]

const HEADING_TAGS: ReadonlySet<string> = new Set<HeadingTag>(["h1", "h2", "h3", "h4", "h5", "h6"])
const ALIGNMENTS: ReadonlySet<string> = new Set<ElementFormat>(["left", "start", "center", "right", "end", "justify"])
const LIST_TYPES: ReadonlySet<string> = new Set<ListType>(["bullet", "number", "check"])
const SAFE_PROTOCOLS: ReadonlySet<string> = new Set(["http", "https", "mailto", "tel", "sms"])
const LINK_TARGETS: ReadonlySet<string> = new Set(["_blank", "_self", "_parent", "_top"])

function isNode(value: unknown): value is RichTextNode {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
}

function isHeadingTag(value: string | undefined): value is HeadingTag {
  return value !== undefined && HEADING_TAGS.has(value)
}

function isListType(value: string | undefined): value is ListType {
  return value !== undefined && LIST_TYPES.has(value)
}

function stringField(node: RichTextNode, key: string): string | undefined {
  const value = node[key]
  return typeof value === "string" ? value : undefined
}

function integerField(node: RichTextNode, key: string): number | undefined {
  const value = node[key]
  return typeof value === "number" && Number.isInteger(value) ? value : undefined
}

function element(tag: RichTextTag, attributes: RichTextAttributes = {}, children: RichTextChild[] = []): RichTextElement {
  return { tag, attributes, children }
}

function walkChildren(node: RichTextNode, context: WalkContext): RichTextChild[] {
  const children: unknown = node.children
  if (!Array.isArray(children)) return []
  return children.flatMap((child: unknown) => (isNode(child) ? walk(child, context) : []))
}

/** Alignment, indent and direction: the attributes every block element shares. */
function blockAttributes(node: RichTextNode): RichTextAttributes {
  const format = stringField(node, "format")
  const indent = integerField(node, "indent")
  const direction = stringField(node, "direction")
  const style: RichTextStyle = {
    ...(format !== undefined && ALIGNMENTS.has(format) && { textAlign: format }),
    ...(indent !== undefined && indent > 0 && { paddingInlineStart: `calc(${indent} * 40px)` }),
  }
  return {
    ...((direction === "ltr" || direction === "rtl") && { dir: direction }),
    ...(Object.keys(style).length > 0 && { style }),
  }
}

function textRun(node: RichTextNode, context: WalkContext): RichTextChild[] {
  const text = stringField(node, "text") ?? ""
  if (text === "") return []
  const format = context.inCode ? 0 : (integerField(node, "format") ?? 0)
  let out: RichTextChild = text
  for (const [bit, value] of TEXT_TRANSFORMS) {
    if (format & bit) out = element("span", { style: { textTransform: value } }, [out])
  }
  for (const [bit, tag] of FORMAT_TAGS) {
    if (format & bit) out = element(tag, {}, [out])
  }
  return [out]
}

function paragraph(node: RichTextNode, context: WalkContext): RichTextChild[] {
  const children = walkChildren(node, context)
  // An empty paragraph keeps its line, as Lexical's own HTML export does.
  return [element("p", blockAttributes(node), children.length > 0 ? children : [element("br")])]
}

function heading(node: RichTextNode, context: WalkContext): RichTextChild[] {
  const tag = stringField(node, "tag")
  if (!isHeadingTag(tag)) return paragraph(node, context)
  return [element(tag, blockAttributes(node), walkChildren(node, context))]
}

function list(node: RichTextNode, context: WalkContext): RichTextChild[] {
  const raw = stringField(node, "listType")
  const listType: ListType = isListType(raw) ? raw : "bullet"
  const start = integerField(node, "start")
  const ordered = listType === "number"
  const attributes: RichTextAttributes = ordered && start !== undefined && start !== 1 ? { start } : {}
  return [element(ordered ? "ol" : "ul", attributes, walkChildren(node, { ...context, listType }))]
}

/** A nested list lives in a list item of its own, which carries no marker and no number. */
function holdsOnlyLists(node: RichTextNode): boolean {
  const children: unknown = node.children
  return Array.isArray(children) && children.length > 0 && children.every((c: unknown) => isNode(c) && c.type === "list")
}

function listItem(node: RichTextNode, context: WalkContext): RichTextChild[] {
  const children = walkChildren(node, context)
  if (holdsOnlyLists(node)) return [element("li", { style: { listStyleType: "none" } }, children)]
  const value = integerField(node, "value")
  const attributes: RichTextAttributes = context.listType === "number" && value !== undefined ? { value } : {}
  if (context.listType !== "check") return [element("li", attributes, children)]
  const checkbox = element("input", { type: "checkbox", ...(node["checked"] === true && { checked: true }), disabled: true })
  return [element("li", attributes, [checkbox, ...children])]
}

/**
 * The URL a link may point at, or undefined when it must not be a link at all. Browsers drop tabs
 * and newlines anywhere in a URL and control characters around it, so `java\tscript:` is checked
 * the way a browser would read it. Anything with a scheme outside the allow list is refused;
 * a URL with no scheme is relative and stays.
 */
export function safeHref(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  const normalized = url.replace(/[\t\n\r]/g, "").replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, "")
  if (normalized === "") return undefined
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(normalized)?.[1]
  if (scheme !== undefined && !SAFE_PROTOCOLS.has(scheme.toLowerCase())) return undefined
  return normalized
}

function relFor(rel: string | undefined, target: string | undefined): string | undefined {
  const tokens = (rel ?? "").split(/\s+/).filter((token) => token !== "")
  if (target === "_blank") {
    for (const required of ["noopener", "noreferrer"]) if (!tokens.includes(required)) tokens.push(required)
  }
  return tokens.length > 0 ? tokens.join(" ") : undefined
}

function link(node: RichTextNode, context: WalkContext): RichTextChild[] {
  const children = walkChildren(node, context)
  if (node.type === "autolink" && node["isUnlinked"] === true) return children
  const href = safeHref(stringField(node, "url"))
  if (href === undefined) return children
  const requested = stringField(node, "target")
  const target = requested !== undefined && LINK_TARGETS.has(requested) ? requested : undefined
  const rel = relFor(stringField(node, "rel"), target)
  const title = stringField(node, "title")
  const attributes: RichTextAttributes = {
    href,
    ...(rel !== undefined && { rel }),
    ...(target !== undefined && { target }),
    ...(title !== undefined && { title }),
  }
  return [element("a", attributes, children)]
}

function codeBlock(node: RichTextNode): RichTextChild[] {
  const language = stringField(node, "language")
  const attributes: RichTextAttributes = language !== undefined && language !== "" ? { class: `language-${language}` } : {}
  const children = walkChildren(node, { inCode: true, listType: null })
  return [element("pre", {}, [element("code", attributes, children)])]
}

/** A node type this walker does not know: its words, so nothing written is lost. */
function unknownNode(node: RichTextNode, context: WalkContext): RichTextChild[] {
  if (typeof node["text"] === "string") return textRun(node, context)
  return walkChildren(node, context)
}

const RENDERERS: ReadonlyMap<string, NodeRenderer> = new Map<string, NodeRenderer>([
  ["root", walkChildren],
  ["paragraph", paragraph],
  ["heading", heading],
  ["quote", (node, context) => [element("blockquote", blockAttributes(node), walkChildren(node, context))]],
  ["list", list],
  ["listitem", listItem],
  ["link", link],
  ["autolink", link],
  ["code", codeBlock],
  ["text", textRun],
  ["tab", textRun],
  ["code-highlight", textRun],
  ["linebreak", (_node, context) => [context.inCode ? "\n" : element("br")]],
  ["horizontalrule", () => [element("hr")]],
])

function walk(node: RichTextNode, context: WalkContext): RichTextChild[] {
  return (RENDERERS.get(node.type) ?? unknownNode)(node, context)
}

function topLevelNodes(content: unknown): readonly unknown[] {
  if (typeof content !== "object" || content === null) return []
  if (Array.isArray(content)) return content
  if (isNode(content)) return [content]
  return "root" in content ? [content.root] : []
}

/**
 * Walk a saved document into the element tree every renderer prints.
 *
 * Takes any value, not only a `RichTextContent`: a column holds whatever was written to it, and
 * anything that is not a document prints as nothing.
 */
export function richTextTree(content: unknown): RichTextChild[] {
  return topLevelNodes(content).flatMap((node) => (isNode(node) ? walk(node, TOP) : []))
}
