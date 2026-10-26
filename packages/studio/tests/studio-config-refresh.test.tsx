// @vitest-environment jsdom
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, useNavigate } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  ConfigRefreshOnNavigate,
  useStudioConfig,
  type StudioConfigHandle,
} from "../src/hooks/useStudioConfig.js"
import type { StudioConfigFetch } from "../src/lib/studio-config-fetch.js"

/**
 * A schema pushed while Studio is open reaches the editor without a reload.
 *
 * Studio used to read `/studio-config` once, when the tab loaded. The Schema tab merges live
 * database columns into what it shows, so a newly pushed column appeared there, while the Editor,
 * which renders only the config's fields, kept the field list from page load until a reload.
 */

type Field = { name: string; widget: string; required: boolean }
type RawModel = { name: string; tableName: string; fields: Field[] }

const field = (name: string, widget = "text"): Field => ({ name, widget, required: false })

function body(models: RawModel[]): string {
  return JSON.stringify({ models, globals: [], navigation: [] })
}

const speaker = (extra: Field[] = []): RawModel => ({
  name: "Speaker",
  tableName: "speaker",
  fields: [field("id"), field("name"), ...extra],
})
const room: RawModel = { name: "Room", tableName: "room", fields: [field("id"), field("label")] }

/** A config endpoint whose answer the test changes, the way a push changes the engine's. */
function endpoint(initial: string) {
  const state = { current: initial, calls: 0, fail: false }
  const load = async (): Promise<StudioConfigFetch> => {
    state.calls += 1
    if (state.fail) return { ok: false, kind: "network", detail: "offline" }
    return { ok: true, body: state.current }
  }
  return { state, load }
}

let container: HTMLDivElement
let root: Root
let handle: StudioConfigHandle | null

function Probe({ load, interval }: { load: () => Promise<StudioConfigFetch>; interval: number }): null {
  handle = useStudioConfig(load, interval)
  return null
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function mount(load: () => Promise<StudioConfigFetch>, interval = 0): Promise<void> {
  await act(async () => root.render(<Probe load={load} interval={interval} />))
  await flush()
}

function fieldNames(model: string): string[] {
  const state = handle!.state
  if (state.phase !== "ready") throw new Error(`config not ready: ${state.phase}`)
  return state.config.models.find((m) => m.name === model)!.fields.map((f) => f.name)
}

function readyConfig() {
  const state = handle!.state
  if (state.phase !== "ready") throw new Error(`config not ready: ${state.phase}`)
  return state.config
}

async function focusWindow(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event("focus"))
  })
  await flush()
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  handle = null
  container = document.createElement("div")
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
})

describe("useStudioConfig", () => {
  it("picks up a field pushed while Studio is open when the window regains focus", async () => {
    const api = endpoint(body([speaker(), room]))
    await mount(api.load)
    expect(fieldNames("Speaker")).toEqual(["id", "name"])

    api.state.current = body([speaker([field("is_active", "boolean")]), room])
    await focusWindow()

    expect(fieldNames("Speaker")).toEqual(["id", "name", "is_active"])
  })

  it("picks up a pushed field when Studio navigates", async () => {
    const api = endpoint(body([speaker(), room]))
    let go: ((path: string) => void) | null = null
    function Nav(): null {
      const navigate = useNavigate()
      go = (path) => navigate(path)
      return null
    }
    function App(): React.ReactElement {
      handle = useStudioConfig(api.load, 0)
      return (
        <MemoryRouter initialEntries={["/models/Room"]}>
          <ConfigRefreshOnNavigate refresh={handle.refresh} />
          <Nav />
        </MemoryRouter>
      )
    }
    await act(async () => root.render(<App />))
    await flush()
    const loadsBefore = api.state.calls

    api.state.current = body([speaker([field("is_active", "boolean")]), room])
    await act(async () => go!("/models/Speaker"))
    await flush()

    expect(api.state.calls).toBe(loadsBefore + 1)
    expect(fieldNames("Speaker")).toEqual(["id", "name", "is_active"])
  })

  it("keeps the same config object when nothing was pushed, so no view re-renders", async () => {
    const api = endpoint(body([speaker(), room]))
    await mount(api.load)
    const before = readyConfig()

    await focusWindow()

    expect(api.state.calls).toBe(2)
    expect(readyConfig()).toBe(before)
  })

  it("keeps an unchanged model's identity, so a form open on it keeps its unsaved edits", async () => {
    const api = endpoint(body([speaker(), room]))
    await mount(api.load)
    const roomBefore = readyConfig().models.find((m) => m.name === "Room")
    const speakerBefore = readyConfig().models.find((m) => m.name === "Speaker")

    api.state.current = body([speaker([field("is_active", "boolean")]), room])
    await focusWindow()

    expect(readyConfig().models.find((m) => m.name === "Room")).toBe(roomBefore)
    expect(readyConfig().models.find((m) => m.name === "Speaker")).not.toBe(speakerBefore)
  })

  it("keeps the loaded config when a background refresh fails", async () => {
    const api = endpoint(body([speaker(), room]))
    await mount(api.load)
    const before = readyConfig()

    api.state.fail = true
    await focusWindow()

    expect(handle!.state.phase).toBe("ready")
    expect(readyConfig()).toBe(before)
  })

  it("asks at most once per interval however often focus fires", async () => {
    const api = endpoint(body([speaker(), room]))
    await mount(api.load, 60_000)

    await focusWindow()
    await focusWindow()

    expect(api.state.calls).toBe(1)
  })
})
