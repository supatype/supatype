// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import React, { useRef, useState } from "react"
import { DisclosureButton, IconButton, Input, ListButton, Switch, Table, Tabs, TextLink, type TabsSpec } from "../src/components/ui.js"
import { act, elementOf, isolateEachTest, mount } from "./support.js"

/**
 * The shared controls the views and the content editor build from. Each says what it is to a
 * screen reader and to a keyboard, so a view that uses them gets that without writing it.
 */

isolateEachTest()

/** Presses `key` on the focused element, the way a keyboard does. */
async function key(name: string): Promise<void> {
  const target = document.activeElement ?? document.body
  await act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })) })
}

const SPEC: TabsSpec<"a" | "b" | "c"> = { label: "Sections", items: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }] }

function PickedTabs(): React.ReactElement {
  const [value, setValue] = useState<"a" | "b" | "c">("a")
  return <Tabs tabs={SPEC} value={value} onChange={setValue} />
}

/** The tabs' state: which is selected and which is in the tab order, with what has focus. */
function tabState(): string[] {
  return [...document.querySelectorAll('[role="tab"]')].map((t) =>
    `${t.textContent}:${t.getAttribute("aria-selected")}:${t.getAttribute("tabindex")}:${t === document.activeElement ? "focus" : ""}`,
  )
}

describe("Tabs", () => {
  it("is a named tablist whose selected tab alone is in the tab order", async () => {
    const { container } = await mount(<PickedTabs />)
    expect(container.querySelector('[role="tablist"]')?.getAttribute("aria-label")).toBe("Sections")
    expect(tabState()).toEqual(["A:true:0:", "B:false:-1:", "C:false:-1:"])
  })

  it("moves and selects with the arrow keys, Home and End, wrapping at the ends", async () => {
    await mount(<PickedTabs />)
    const first = document.querySelector<HTMLButtonElement>('[role="tab"]')
    await act(() => { first?.focus() })
    await key("ArrowRight")
    expect(tabState()).toEqual(["A:false:-1:", "B:true:0:focus", "C:false:-1:"])
    await key("End")
    expect(tabState()[2]).toBe("C:true:0:focus")
    await key("ArrowRight")
    expect(tabState()[0]).toBe("A:true:0:focus")
    await key("ArrowLeft")
    expect(tabState()[2]).toBe("C:true:0:focus")
    await key("Home")
    expect(tabState()[0]).toBe("A:true:0:focus")
  })

  it("closes a closable tab from its own named button, without selecting it", async () => {
    const onClose = vi.fn()
    const onChange = vi.fn()
    const spec: TabsSpec<"a"> = { label: "Results", items: [{ id: "a", label: "Run 1", close: { label: "Close Run 1", onClose } }] }
    await mount(<Tabs tabs={spec} value="a" onChange={onChange} />)
    await act(() => { document.querySelector<HTMLButtonElement>('[aria-label="Close Run 1"]')?.click() })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe("IconButton", () => {
  it("names itself for a screen reader and a pointer", async () => {
    const { container } = await mount(<IconButton label="Close panel">x</IconButton>)
    const button = container.querySelector("button")
    expect([button?.getAttribute("aria-label"), button?.getAttribute("title"), button?.getAttribute("type")]).toEqual(["Close panel", "Close panel", "button"])
  })
})

describe("TextLink", () => {
  it("is an anchor with href and a button without", async () => {
    const { container } = await mount(<p><TextLink href="/x">Go</TextLink><TextLink onClick={() => {}}>Act</TextLink></p>)
    expect([...container.querySelectorAll('[data-ui="text-link"]')].map((el) => `${el.tagName}:${el.getAttribute("type") ?? ""}`)).toEqual(["A:", "BUTTON:button"])
  })
})

describe("ListButton", () => {
  it("marks the selected choice as current", async () => {
    const { container } = await mount(<div><ListButton selected>a</ListButton><ListButton>b</ListButton></div>)
    expect([...container.querySelectorAll("button")].map((b) => b.getAttribute("aria-current"))).toEqual(["true", null])
  })
})

describe("DisclosureButton", () => {
  it("says whether it is open, and claims nothing when there is nothing to disclose", async () => {
    const { container } = await mount(<div><DisclosureButton open>a</DisclosureButton><DisclosureButton open={false}>b</DisclosureButton><DisclosureButton open={undefined}>c</DisclosureButton></div>)
    expect([...container.querySelectorAll("button")].map((b) => `${b.getAttribute("aria-expanded")}:${b.disabled}`)).toEqual(["true:false", "false:false", "null:true"])
  })
})

describe("Switch", () => {
  it("is a named switch that reports the flipped state", async () => {
    const onChange = vi.fn()
    const { container } = await mount(<Switch label="Introspection" checked={false} onChange={onChange} />)
    const sw = elementOf(container, '[role="switch"]', HTMLButtonElement)
    expect([sw.getAttribute("aria-label"), sw.getAttribute("aria-checked")]).toEqual(["Introspection", "false"])
    await act(() => { sw.click() })
    expect(onChange).toHaveBeenCalledWith(true)
  })
})

describe("Input and Table", () => {
  it("hands a ref to the input, and marks the table as shared", async () => {
    let seen: HTMLInputElement | null = null
    function WithRef(): React.ReactElement {
      const ref = useRef<HTMLInputElement>(null)
      return <><Input ref={ref} aria-label="q" /><button type="button" onClick={() => { seen = ref.current }}>read</button><Table><tbody /></Table></>
    }
    const { container } = await mount(<WithRef />)
    await act(() => { container.querySelector("button")?.click() })
    expect(seen).toBe(container.querySelector("input"))
    expect(container.querySelector('table[data-ui="table"]')).toBeTruthy()
  })
})
