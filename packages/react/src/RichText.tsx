import { createElement, type ReactElement, type ReactNode } from "react"
import {
  richTextTree,
  type RichTextAttributes,
  type RichTextChild,
  type RichTextContent,
} from "@supatype/common/richtext"

export interface RichTextProps {
  /** A saved Lexical document: the editor state (`{ root }`), its root node, a list of nodes, or null. */
  content: RichTextContent
  /** Optional CSS class applied to the wrapper element. */
  className?: string
  /** Wrapper element tag. Defaults to `"div"`. */
  as?: "div" | "article" | "section" | "aside" | "main"
}

/** React's names for the two attributes that differ from HTML, in the order the walker set them. */
function reactProps(attributes: RichTextAttributes, key: number): Record<string, unknown> {
  const props: Record<string, unknown> = { key }
  for (const [name, value] of Object.entries(attributes)) {
    if (name === "class") props["className"] = value
    else if (name === "checked") props["defaultChecked"] = value
    else props[name] = value
  }
  return props
}

function toReactNode(child: RichTextChild, index: number): ReactNode {
  if (typeof child === "string") return child
  return createElement(child.tag, reactProps(child.attributes, index), ...child.children.map(toReactNode))
}

/**
 * Renders a saved Lexical rich text document as React elements.
 *
 * The document is walked by `richTextTree` from @supatype/common, the same walker the HTML string
 * renderer uses, so both print the same thing. Text becomes React text children, never HTML, and
 * links only keep a safe href. Works in both Server Components and Client Components.
 */
export function RichText({ content, className, as: Tag = "div" }: RichTextProps): ReactElement | null {
  if (content === null || content === undefined) return null
  return <Tag {...(className !== undefined && { className })}>{richTextTree(content).map(toReactNode)}</Tag>
}
