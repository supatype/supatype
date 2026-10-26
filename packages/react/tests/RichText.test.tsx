/**
 * `RichText` must render a saved Lexical document exactly as the HTML string renderer does, since
 * both print the same tree from @supatype/common. These run the shared cases through React and
 * print what React built back to HTML, so a difference in either renderer fails here.
 */

import React from "react"
import { describe, expect, it } from "vitest"
import { create, type ReactTestRendererJSON } from "react-test-renderer"
import { RichText } from "../src/RichText.js"
import { RENDER_CASES } from "../../common/tests/richtext-cases.js"

type Rendered = ReactTestRendererJSON | string

const ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
const VOID_TAGS: ReadonlySet<string> = new Set(["br", "hr", "input"])
const PROP_NAMES: Readonly<Record<string, string>> = { className: "class", defaultChecked: "checked" }

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char)
}

function cssText(style: object): string {
  return Object.entries(style)
    .map(([property, value]) => `${property.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${String(value)}`)
    .join(";")
}

function propText(name: string, value: unknown): string {
  const attribute = PROP_NAMES[name] ?? name
  if (value === true) return ` ${attribute}`
  if (value === false || value === undefined) return ""
  const printed = typeof value === "object" && value !== null ? cssText(value) : String(value)
  return ` ${attribute}="${escapeHtml(printed)}"`
}

function toHtml(node: Rendered): string {
  if (typeof node === "string") return escapeHtml(node)
  const attributes = Object.entries(node.props).map(([name, value]) => propText(name, value)).join("")
  if (VOID_TAGS.has(node.type)) return `<${node.type}${attributes} />`
  return `<${node.type}${attributes}>${(node.children ?? []).map(toHtml).join("")}</${node.type}>`
}

function wrapper(element: React.ReactElement): ReactTestRendererJSON {
  const json = create(element).toJSON()
  if (json === null || Array.isArray(json)) throw new Error("RichText should render one wrapper element")
  return json
}

describe("RichText renders what Lexical saves", () => {
  it.each(RENDER_CASES)("$name", ({ content, html }) => {
    const rendered = wrapper(<RichText content={content} />)
    expect((rendered.children ?? []).map(toHtml).join("")).toBe(html)
  })
})

describe("RichText element", () => {
  const xss = RENDER_CASES.find((c) => c.name.startsWith("script"))

  it("builds elements rather than injecting an HTML string", () => {
    if (xss === undefined) throw new Error("xss case missing")
    const rendered = wrapper(<RichText content={xss.content} />)
    expect(rendered.props).not.toHaveProperty("dangerouslySetInnerHTML")
    const first = rendered.children?.[0]
    expect(typeof first === "object" && first.children).toEqual(["<script>alert(\"x\")</script> & 'quotes'"])
  })

  it("keeps the wrapper props: className and the element tag", () => {
    const rendered = wrapper(<RichText content={[]} className="prose" as="article" />)
    expect(rendered.type).toBe("article")
    expect(rendered.props).toEqual({ className: "prose" })
  })

  it("renders nothing for null content", () => {
    expect(create(<RichText content={null} />).toJSON()).toBeNull()
  })
})
