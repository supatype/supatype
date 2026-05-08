import { renderRichText, type RichTextNode } from "@supatype/common/richtext"

export interface RichTextProps {
  /** Lexical JSON content — a root node, an array of child nodes, or null. */
  content: RichTextNode | RichTextNode[] | null | undefined
  /** Optional CSS class applied to the wrapper element. */
  className?: string
  /** Wrapper element tag. Defaults to `"div"`. */
  as?: "div" | "article" | "section" | "aside" | "main"
}

/**
 * Renders a Lexical rich-text JSON tree as HTML.
 *
 * Works in both Server Components and Client Components.
 */
export function RichText({
  content,
  className,
  as: Tag = "div",
}: RichTextProps): React.ReactElement | null {
  if (content == null) return null

  const node: RichTextNode = Array.isArray(content)
    ? { type: "root", children: content }
    : content

  const html = renderRichText(node)

  return <Tag className={className} dangerouslySetInnerHTML={{ __html: html }} />
}
