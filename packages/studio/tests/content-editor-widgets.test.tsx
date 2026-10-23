// @vitest-environment jsdom
import React from "react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it, vi, type Mock } from "vitest"
import { $getRoot, $isTextNode, type LexicalEditor } from "lexical"
import type { FieldConfig } from "../src/config.js"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { FieldWidget, type WidgetProps } from "../src/widgets/FieldWidget.js"
import { BlocksWidget } from "../src/widgets/BlocksWidget.js"
import { ButtonWidget } from "../src/widgets/ButtonWidget.js"
import { FileWidget } from "../src/widgets/FileWidget.js"
import { ImageWidget } from "../src/widgets/ImageWidget.js"
import { PublishWidget } from "../src/widgets/PublishWidget.js"
import { RelationWidget } from "../src/widgets/RelationWidget.js"
import { RichTextWidget } from "../src/widgets/RichTextWidget.js"
import { SlugWidget } from "../src/widgets/SlugWidget.js"
import { act, advance, button, elementOf, isolateEachTest, mount, settle, testClient, testConfig, testField, testModel } from "./support.js"

/**
 * The content editor's widgets are drawn from the shared primitives (`data-ui` names which), and
 * what an editor does with them still works: typing, picking, uploading, dropping, the toolbar and
 * the relation picker from the keyboard as well as the pointer.
 */

isolateEachTest()

const PROXY = "http://localhost:8000/studio/proxy"
const CLIENT = testClient({ url: PROXY, token: "token" })
const CONFIG = testConfig({ models: [testModel({ name: "thing", label: "Thing", tableName: "things" })] })
const THINGS = [{ id: "t1", name: "thing 1" }, { id: "t2", name: "thing 2" }]

/** A request a widget sent: where, and how. */
interface Sent {
  url: string
  method: string
}

/** Every request a widget sent, and answers that suit storage and the REST tables the tests use. */
function stubServer(): Sent[] {
  const sent: Sent[] = []
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    sent.push({ url: input, method: init?.method ?? "GET" })
    const url = new URL(input)
    if (url.pathname.endsWith("/rest/v1/things")) return Response.json(THINGS)
    if (url.pathname.includes("/storage/v1/object/list/")) return Response.json([])
    if (url.pathname.includes("/storage/v1/object/")) return Response.json({ Key: url.pathname })
    return Response.json([])
  })
  return sent
}

/** `ui` mounted with the config and client a widget reads, and the requests it sends. */
async function show(ui: React.ReactElement): Promise<{ container: HTMLElement; sent: Sent[] }> {
  const sent = stubServer()
  const { container } = await mount(
    <MemoryRouter>
      <AdminConfigContext.Provider value={CONFIG}>
        <AdminClientContext.Provider value={CLIENT}>{ui}</AdminClientContext.Provider>
      </AdminConfigContext.Provider>
    </MemoryRouter>,
  )
  await settle()
  return { container, sent }
}

/** A widget's props for `config`, with `value` and a spy for what it hands the form. */
/** What a widget hands the form, recorded. */
type OnChange = Mock<(value: unknown) => void>

function props(config: FieldConfig, value: unknown = null, over: Partial<WidgetProps> = {}): WidgetProps & { onChange: OnChange } {
  return { config, value, readOnly: false, ...over, onChange: vi.fn<(value: unknown) => void>() }
}

const primitive = (el: Element | null): string | null => el?.getAttribute("data-ui") ?? null
const field = (root: ParentNode, name: string): Element | null => root.querySelector(`#field-${name}`)

async function click(el: Element): Promise<void> {
  await act(() => { if (el instanceof HTMLElement) el.click() })
  await settle()
}

async function key(el: Element, name: string): Promise<void> {
  await act(() => { el.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })) })
  await settle()
}

/** `text` typed into `input`, as React hears typing. */
async function type(input: HTMLInputElement, text: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  await act(() => { setter?.call(input, text); input.dispatchEvent(new Event("input", { bubbles: true })) })
}

/** `files` chosen in a hidden file input, as the browser's chooser reports them. */
async function choose(input: HTMLInputElement, files: File[]): Promise<void> {
  Object.defineProperty(input, "files", { configurable: true, value: Object.assign([...files], { item: (i: number) => files[i] ?? null }) })
  await act(() => { input.dispatchEvent(new Event("change", { bubbles: true })) })
  await settle()
}

const uploads = (sent: Sent[]): Sent[] => sent.filter((r) => r.method === "POST" && r.url.includes("/storage/v1/object/") && !r.url.includes("/list/"))

describe("the plain field widgets", () => {
  it.each([
    ["text", testField({ name: "title" })],
    ["number", testField({ name: "count", widget: "number" })],
    ["date", testField({ name: "day", widget: "date" })],
    ["currency", testField({ name: "price", widget: "currency" })],
    ["colour", testField({ name: "tint", widget: "color" })],
  ])("draw a %s field as the shared input", async (_, config) => {
    const { container } = await show(<FieldWidget {...props(config)} />)
    expect(primitive(field(container, config.name))).toBe("input")
  })

  it("draws a long text field as the shared textarea and a choice as the shared select", async () => {
    const { container } = await show(
      <>
        <FieldWidget {...props(testField({ name: "body", widget: "textarea" }))} />
        <FieldWidget {...props(testField({ name: "kind", widget: "select", options: { values: ["a", "b"] } }))} />
      </>,
    )
    expect(primitive(field(container, "body"))).toBe("textarea")
    expect(primitive(field(container, "kind"))).toBe("select")
  })

  it("draws a yes/no field as the shared switch, which hands the form the new value", async () => {
    const p = props(testField({ name: "featured", label: "Featured", widget: "boolean" }), false)
    const { container } = await show(<FieldWidget {...p} />)
    const toggle = elementOf(container, "#field-featured", HTMLButtonElement)
    expect(primitive(toggle)).toBe("switch")
    await click(toggle)
    expect(p.onChange).toHaveBeenCalledWith(true)
  })

  it("disables a read-only yes/no field's switch", async () => {
    const { container } = await show(<FieldWidget {...props(testField({ name: "featured", widget: "boolean" }), true, { readOnly: true })} />)
    expect(elementOf(container, "#field-featured", HTMLButtonElement).disabled).toBe(true)
  })

  it("refills a slug from its source with the shared icon button", async () => {
    const p = props(testField({ name: "slug", widget: "slug" }), "old", { record: { title: "Hello World" } })
    const { container } = await show(<FieldWidget {...p} />)
    const refill = button(container, "Regenerate slug from title")
    expect(primitive(refill)).toBe("button")
    await click(refill)
    expect(p.onChange).toHaveBeenLastCalledWith("hello-world")
  })

  it("follows its source while a record is created, until the editor types over it", async () => {
    const onChange = vi.fn<(value: unknown) => void>()
    const slug = (title: string, value: unknown): React.ReactElement => (
      <SlugWidget config={testField({ name: "slug", widget: "slug" })} value={value} onChange={onChange} readOnly={false} record={{ title }} slugFollowSource />
    )
    const view = await mount(slug("Hello", null))
    expect(onChange).toHaveBeenLastCalledWith("hello")
    await act(() => { view.root.render(slug("Hello there", "hello")) })
    expect(onChange).toHaveBeenLastCalledWith("hello-there")
    await type(elementOf(view.container, "#field-slug", HTMLInputElement), "mine")
    expect(onChange).toHaveBeenLastCalledWith("mine")
    onChange.mockClear()
    await act(() => { view.root.render(slug("Another title", "mine")) })
    expect(onChange).not.toHaveBeenCalled()
  })

  it("refills derived text from its sources with the shared icon button", async () => {
    const config = testField({ name: "summary", widget: "derivedText", options: { sources: ["title", "subtitle"] } })
    const p = props(config, "typed", { record: { title: "Big", subtitle: "News" } })
    const { container } = await show(<FieldWidget {...p} />)
    expect(primitive(field(container, "summary"))).toBe("input")
    await click(button(container, "Refill preview from title, subtitle"))
    expect(p.onChange).toHaveBeenLastCalledWith("Big News")
  })

  it("shows why a field was refused under it", async () => {
    const { container } = await show(<FieldWidget {...props(testField({ name: "title" }), "x", { error: "Too short" })} />)
    expect(container.querySelector("#field-title-error")?.textContent).toBe("Too short")
    expect(container.querySelector("[role=alert]")?.textContent).toBe("Too short")
  })
})

describe("the publish widget", () => {
  it("shows the status as the shared badge and moves it with the shared buttons", async () => {
    const p = props(testField({ name: "status", widget: "publish" }), "draft")
    const { container } = await show(<PublishWidget {...p} />)
    expect(container.querySelector("[data-ui=badge]")?.textContent).toBe("draft")
    const publish = button(container, "Publish")
    expect(primitive(publish)).toBe("button")
    await click(publish)
    expect(p.onChange).toHaveBeenCalledWith("published")
    await click(button(container, "Schedule..."))
    expect(primitive(container.querySelector("input[type=datetime-local]"))).toBe("input")
  })
})

describe("the file widget", () => {
  it("chooses a file with the shared button and a hidden shared file input, and stores the upload", async () => {
    const p = props(testField({ name: "doc", label: "Document", widget: "file", options: { bucket: "files" } }))
    const { container, sent } = await show(<FileWidget {...p} />)
    expect(primitive(button(container, "Choose file"))).toBe("button")
    const input = elementOf(container, "[data-ui=file-input]", HTMLInputElement)
    expect(input.hidden).toBe(true)
    await choose(input, [new File(["x"], "spec.pdf", { type: "application/pdf" })])
    expect(uploads(sent)).toHaveLength(1)
    expect(p.onChange).toHaveBeenCalledWith(expect.objectContaining({ bucket: "files", mimeType: "application/pdf" }))
  })
})

/** A drop of `file` on `target`, carrying it as the browser's drag data does. */
async function drop(target: Element, file: File): Promise<void> {
  const event = new Event("drop", { bubbles: true, cancelable: true })
  Object.defineProperty(event, "dataTransfer", { value: { files: [file] } })
  await act(() => { target.dispatchEvent(event) })
  await settle()
}

describe("the image widget", () => {
  const IMAGE = testField({ name: "cover", label: "Cover", widget: "image", options: { bucket: "images" } })
  const png = (): File => new File(["x"], "pic.png", { type: "image/png" })

  it("asks for an image in the shared drop zone, with the shared buttons and file input", async () => {
    const { container } = await show(<ImageWidget {...props(IMAGE)} />)
    expect(container.querySelector("[data-ui=drop-zone]")).not.toBeNull()
    expect(primitive(button(container, "Upload"))).toBe("button")
    expect(primitive(button(container, "Select from bucket"))).toBe("button")
    expect(container.querySelector("[data-ui=file-input]")).not.toBeNull()
  })

  it("uploads an image dropped on the field and stores it", async () => {
    const p = props(IMAGE)
    const { container, sent } = await show(<ImageWidget {...p} />)
    await drop(elementOf(container, "[data-ui=drop-zone]", HTMLElement), png())
    expect(uploads(sent)).toHaveLength(1)
    expect(p.onChange).toHaveBeenCalledWith(expect.objectContaining({ bucket: "images", mimeType: "image/png" }))
  })

  // Its buttons were disabled, but a drop still uploaded into the bucket and changed the record.
  it("takes no drop on a read-only field", async () => {
    const p = props(IMAGE, null, { readOnly: true })
    const { container, sent } = await show(<ImageWidget {...p} />)
    await drop(elementOf(container, "[data-ui=drop-zone]", HTMLElement), png())
    expect(uploads(sent)).toHaveLength(0)
    expect(p.onChange).not.toHaveBeenCalled()
  })

  it("picks from the bucket in the shared modal, which Escape closes", async () => {
    const { container } = await show(<ImageWidget {...props(IMAGE)} />)
    await click(button(container, "Select from bucket"))
    const modal = document.body.querySelector("[data-ui=modal]")
    expect(modal?.getAttribute("role")).toBe("dialog")
    expect(primitive(document.body.querySelector("input[type=search]"))).toBe("input")
    await key(document.body, "Escape")
    expect(document.body.querySelector("[data-ui=modal]")).toBeNull()
  })
})

describe("the button widget", () => {
  it("opens its panel from the shared disclosure button the field's label names", async () => {
    const config = testField({ name: "cta", label: "Call to action", widget: "button" })
    const { container } = await show(<FieldWidget {...props(config, { label: "Book", href: "/book" })} />)
    const summary = elementOf(container, "#field-cta", HTMLButtonElement)
    expect(primitive(summary)).toBe("disclosure-button")
    expect(summary.getAttribute("aria-expanded")).toBe("false")
    await click(summary)
    expect(primitive(field(container, "cta-label"))).toBe("input")
    const preview = container.querySelector("[data-ui=button-link]")
    expect(preview?.getAttribute("href")).toBe("/book")
  })

  it("hands the form the edited button", async () => {
    const p = props(testField({ name: "cta", widget: "button" }), null)
    const { container } = await show(<ButtonWidget {...p} />)
    await type(elementOf(container, "#field-cta-label", HTMLInputElement), "Go")
    expect(p.onChange).toHaveBeenLastCalledWith(expect.objectContaining({ label: "Go" }))
  })
})

describe("the blocks widget", () => {
  it("draws each block as the shared card with shared icon buttons", async () => {
    const config = testField({ name: "body", widget: "blocks", options: { blockTypes: [{ name: "hero", label: "Hero", fields: [] }] } })
    const { container } = await show(<BlocksWidget {...props(config, [{ type: "hero", data: {} }])} />)
    expect(container.querySelector("[data-block-header]")?.closest("[data-ui=card]")).not.toBeNull()
    expect(primitive(button(container, "Delete Hero"))).toBe("button")
    expect(primitive(button(container, "+ Add block"))).toBe("button")
  })
})

/** Whether `value` is a Lexical editor: what Lexical keeps on the element it edits. */
function isEditor(value: unknown): value is LexicalEditor {
  return typeof value === "object" && value !== null && "update" in value && "dispatchCommand" in value
}

/** The Lexical editor behind a rich text field, read from its editable element. */
function editorOf(container: HTMLElement): LexicalEditor {
  const editor: unknown = Reflect.get(elementOf(container, "[contenteditable]", HTMLElement), "__lexicalEditor")
  if (!isEditor(editor)) throw new Error("no Lexical editor")
  return editor
}

const SAVED = { root: { type: "root", version: 1, direction: null, format: "", indent: 0, children: [{ type: "paragraph", version: 1, direction: null, format: "", indent: 0, textFormat: 0, textStyle: "", children: [{ type: "text", version: 1, text: "Saved words", detail: 0, format: 0, mode: "normal", style: "" }] }] } }

describe("the rich text toolbar", () => {
  it("is a named toolbar of shared buttons", async () => {
    const { container } = await show(<RichTextWidget {...props(testField({ name: "abstract", widget: "richtext" }), SAVED)} />)
    const toolbar = container.querySelector("[role=toolbar]")
    expect(toolbar?.getAttribute("aria-label")).toBe("Formatting")
    const bold = button(container, "Bold")
    expect(primitive(bold)).toBe("button")
    expect(toolbar?.contains(bold)).toBe(true)
  })

  // Its buttons acted on mouse down only, so Enter or Space on a focused button did nothing.
  it("formats the selection from a click, which is what Enter and Space send", async () => {
    const p = props(testField({ name: "abstract", widget: "richtext" }), SAVED)
    const { container } = await show(<RichTextWidget {...p} />)
    const editor = editorOf(container)
    await act(() => {
      editor.update(() => {
        const text = $getRoot().getFirstDescendant()
        if ($isTextNode(text)) text.select(0, text.getTextContentSize())
      })
    })
    await settle()
    await click(button(container, "Bold"))
    expect(JSON.stringify(p.onChange.mock.lastCall?.[0])).toContain('"format":1')
  })
})

describe("the relation picker", () => {
  const THING = testField({ name: "thing", label: "Thing", widget: "relation", options: { target: "things", displayField: "name" } })

  async function openPicker(): Promise<{ container: HTMLElement; trigger: HTMLElement; onChange: OnChange }> {
    const p = props(THING)
    const { container } = await show(<RelationWidget {...p} />)
    const trigger = elementOf(container, "[role=combobox]", HTMLElement)
    await click(trigger)
    await advance(50)
    return { container, trigger, onChange: p.onChange }
  }

  it("is the shared field frame, opening on the shared popover of shared list buttons", async () => {
    const { container, trigger } = await openPicker()
    expect(primitive(trigger)).toBe("field-frame")
    expect(container.querySelector("[data-ui=popover] [role=listbox]")).not.toBeNull()
    const options = Array.from(container.querySelectorAll("[role=option]"))
    expect(options.map(primitive)).toEqual(["list-button", "list-button"])
    expect(primitive(document.activeElement)).toBe("input")
  })

  it("picks an option and closes", async () => {
    const { container, onChange } = await openPicker()
    const first = container.querySelector("[role=option]")
    if (!first) throw new Error("no options")
    await click(first)
    expect(onChange).toHaveBeenCalledWith("t1")
    expect(container.querySelector("[role=listbox]")).toBeNull()
  })

  // Escape did nothing: only a click outside closed the picker.
  it("closes on Escape and puts focus back on the field", async () => {
    const { container } = await openPicker()
    await key(elementOf(container, "input[type=search]", HTMLInputElement), "Escape")
    expect(container.querySelector("[role=listbox]")).toBeNull()
    expect(document.activeElement).toBe(container.querySelector("[role=combobox]"))
  })

  it("closes on a click outside it", async () => {
    const { container } = await openPicker()
    await act(() => { document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })) })
    await settle()
    expect(container.querySelector("[role=listbox]")).toBeNull()
  })

  it("views a picked record in the shared slide panel, named for it", async () => {
    const { container } = await show(<RelationWidget {...props(THING, "t1")} />)
    await click(button(container, "View record"))
    expect(document.body.querySelector("[role=dialog][aria-label='Thing: thing 1']")).not.toBeNull()
  })
})
