import { describe, expect, it } from "vitest"
import type { SerializedLexicalNode } from "@supatype/types/lexical"
import { renderRichText, safeHref, type RichTextContent } from "../src/richtext.js"
import { RENDER_CASES } from "./richtext-cases.js"

function paragraph(children: SerializedLexicalNode[]): SerializedLexicalNode {
  return { type: "paragraph", version: 1, format: "", indent: 0, direction: null, children }
}

function text(value: string): SerializedLexicalNode {
  return { type: "text", version: 1, text: value, format: 0, detail: 0, mode: "normal", style: "" }
}

describe("renderRichText renders what Lexical saves", () => {
  it.each(RENDER_CASES)("$name", ({ content, html }) => {
    expect(renderRichText(content)).toBe(html)
  })
})

describe("renderRichText input forms", () => {
  const body = paragraph([text("hi")])

  it("takes the editor state, the root node, or a list of nodes", () => {
    const root: SerializedLexicalNode = { type: "root", version: 1, children: [body] }
    expect(renderRichText({ root })).toBe("<p>hi</p>")
    expect(renderRichText(root)).toBe("<p>hi</p>")
    expect(renderRichText([body, body])).toBe("<p>hi</p><p>hi</p>")
  })

  it("renders nothing for null and undefined", () => {
    expect(renderRichText(null)).toBe("")
    expect(renderRichText(undefined)).toBe("")
  })

  it("renders nothing for a column value that is not a document at all", () => {
    for (const value of ["plain words", 42, true] as const) {
      const fromColumn: unknown = value
      expect(renderRichText(fromColumn as RichTextContent)).toBe("")
    }
  })

  it("keeps an empty paragraph's height the way Lexical's export does", () => {
    expect(renderRichText([paragraph([])])).toBe("<p><br /></p>")
  })

  it("renders the words of a node type it does not know instead of dropping them", () => {
    const mention: SerializedLexicalNode = { type: "mention", version: 1, text: "@nic <b>" }
    const block: SerializedLexicalNode = { type: "custom-block", version: 1, children: [text("inside")] }
    expect(renderRichText([paragraph([mention]), block])).toBe("<p>@nic &lt;b&gt;</p>inside")
  })

  it("ignores fields of the wrong type rather than printing them", () => {
    const heading: SerializedLexicalNode = { type: "heading", version: 1, tag: "script", children: [text("t")] }
    const link: SerializedLexicalNode = { type: "link", version: 1, url: 42, target: "_blank", children: [text("l")] }
    expect(renderRichText([heading, paragraph([link])])).toBe("<p>t</p><p>l</p>")
  })
})

describe("safeHref", () => {
  it.each([
    ["\u0001javascript:alert(1)", undefined],
    ["JAVASCRIPT:alert(1)", undefined],
    ["java\nscript:alert(1)", undefined],
    ["file:///etc/passwd", undefined],
    ["   ", undefined],
    ["  https://example.com  ", "https://example.com"],
    ["//cdn.example.com/a", "//cdn.example.com/a"],
    ["#section", "#section"],
    ["?page=2", "?page=2"],
    ["tel:+441234", "tel:+441234"],
  ])("%j becomes %j", (url, expected) => {
    expect(safeHref(url)).toBe(expected)
  })
})
