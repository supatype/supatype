import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTabNode,
  $createTextNode,
  $getRoot,
  createEditor,
  type ElementFormatType,
  type Klass,
  type LexicalNode,
  type TextFormatType,
} from "lexical"
import { $createHeadingNode, $createQuoteNode, type HeadingTagType } from "@lexical/rich-text"
import { $createListItemNode, $createListNode, type ListType } from "@lexical/list"
import { $createAutoLinkNode, $createLinkNode, type LinkAttributes } from "@lexical/link"
import {
  $createHorizontalRuleNode,
  HorizontalRuleNode,
} from "@lexical/react/LexicalHorizontalRuleNode"

/**
 * Documents built with the real Lexical runtime, so the renderer fixtures are what Lexical writes
 * rather than what someone remembered it writing. Every builder uses only the node classes Studio's
 * rich text widget registers, except `horizontalRule`, which needs `HorizontalRuleNode` on top.
 */

type Build = () => void

function text(value: string, ...formats: TextFormatType[]): LexicalNode {
  const node = $createTextNode(value)
  for (const format of formats) node.toggleFormat(format)
  return node
}

function paragraph(...children: LexicalNode[]): LexicalNode {
  return $createParagraphNode().append(...children)
}

function list(type: ListType, items: LexicalNode[][], start = 1): LexicalNode {
  const node = $createListNode(type, start)
  items.forEach((children, index) => {
    const checked = type === "check" ? index % 2 === 0 : undefined
    node.append($createListItemNode(checked).append(...children))
  })
  return node
}

function link(url: string, label: string, attributes: LinkAttributes = {}): LexicalNode {
  return paragraph($createLinkNode(url, attributes).append(text(label)))
}

const SINGLE_FORMATS: TextFormatType[] = [
  "bold", "italic", "strikethrough", "underline", "code", "subscript", "superscript", "highlight",
  "lowercase", "uppercase", "capitalize",
]

const BUILDERS: Record<string, Build> = {
  formats: () => {
    $getRoot().append(paragraph(...SINGLE_FORMATS.map((f) => text(f, f))))
  },
  formatCombinations: () => {
    $getRoot().append(
      paragraph(
        text("bold italic", "bold", "italic"),
        text("bold code", "bold", "code"),
        text("underline strikethrough", "underline", "strikethrough"),
        text("everything", "bold", "italic", "strikethrough", "underline", "code", "highlight"),
        text("sub and sup", "subscript", "superscript"),
      ),
    )
  },
  headings: () => {
    const tags: HeadingTagType[] = ["h1", "h2", "h3", "h4", "h5", "h6"]
    $getRoot().append(...tags.map((tag) => $createHeadingNode(tag).append(text(`Heading ${tag}`))))
  },
  blockAttributes: () => {
    const formats: ElementFormatType[] = ["left", "center", "right", "justify", "start", "end"]
    $getRoot().append(...formats.map((f) => $createParagraphNode().setFormat(f).append(text(f))))
    $getRoot().append($createParagraphNode().setIndent(2).append(text("indented twice")))
  },
  quote: () => {
    $getRoot().append($createQuoteNode().append(text("Quoted "), text("words", "italic")))
  },
  lists: () => {
    $getRoot().append(
      list("bullet", [[text("apple")], [text("pear", "bold")]]),
      list("number", [[text("first")], [text("second")]], 3),
      list("check", [[text("done")], [text("todo")]]),
    )
  },
  nestedList: () => {
    const nested = list("bullet", [[text("inner one")], [text("inner two")]])
    $getRoot().append(list("number", [[text("outer one")], [nested], [text("outer two")]]))
  },
  links: () => {
    $getRoot().append(
      link("https://example.com/a?b=1&c=2", "plain"),
      link("https://example.com", "new tab", { target: "_blank", rel: "noreferrer", title: "A \"title\"" }),
      link("/relative/path", "relative"),
      link("mailto:someone@example.com", "mail"),
      paragraph($createAutoLinkNode("https://auto.example.com").append(text("https://auto.example.com"))),
      paragraph($createAutoLinkNode("https://unlinked.example.com", { isUnlinked: true }).append(text("unlinked"))),
    )
  },
  breaks: () => {
    $getRoot().append(paragraph(text("line one"), $createLineBreakNode(), text("line two"), $createTabNode(), text("after tab")))
  },
  horizontalRule: () => {
    $getRoot().append(paragraph(text("above")), $createHorizontalRuleNode(), paragraph(text("below")))
  },
  xss: () => {
    $getRoot().append(
      paragraph(text("<script>alert(\"x\")</script> & 'quotes'")),
      link("javascript:alert(1)", "js"),
      link(" JaVaScRiPt:alert(1)", "js mixed case"),
      link("java\tscript:alert(1)", "js with tab"),
      link("data:text/html,<script>alert(1)</script>", "data url"),
      link("vbscript:msgbox(1)", "vbscript"),
      link("https://example.com/\"><script>alert(1)</script>", "attribute breakout", { target: "\"><script>" }),
    )
  },
}

/** The node classes a fixture needs: what the widget registers, plus the rule for `horizontalRule`. */
export function buildLexicalDocuments(widgetNodes: ReadonlyArray<Klass<LexicalNode>>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, build] of Object.entries(BUILDERS)) {
    const editor = createEditor({
      namespace: `fixture-${name}`,
      nodes: [...widgetNodes, HorizontalRuleNode],
      onError: (error) => {
        throw error
      },
    })
    editor.update(build, { discrete: true })
    out[name] = editor.getEditorState().toJSON()
  }
  return out
}
