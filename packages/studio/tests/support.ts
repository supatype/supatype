import React, { act as reactAct, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, vi } from "vitest"
import { createClient, type Session, type SupatypeClient } from "@supatype/client"
import type { AdminConfig, FieldConfig, ModelConfig } from "../src/config.js"
import type { ProjectProxy } from "../src/hooks/useProjectProxy.js"
import { isRecordOf, isShape, isString, isUnknown, optional } from "../src/lib/json.js"

/**
 * Builders the Studio suites share, so a test states only the parts of a value it is about and
 * still hands the code under test a complete one.
 */

/** A signed-in session for `token` that stays valid for an hour and never schedules a refresh. */
function sessionFor(token: string): Session {
  return {
    accessToken: token,
    tokenType: "bearer",
    expiresIn: 3600,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    // Empty, so the client sets no refresh timer and never calls the auth server on its own.
    refreshToken: "",
    user: { id: "test-user", appMetadata: {}, userMetadata: {}, createdAt: "", updatedAt: "" },
  }
}

export interface TestClientOptions {
  url: string
  /** The signed-in user's access token; omitted or null for nobody signed in. */
  token?: string | null
  serviceRoleKey?: string
}

/**
 * A real client for `url`, signed in with `token` when one is given.
 *
 * Built without persistence or URL detection, so constructing it reads no storage and sends nothing.
 */
export function testClient({ url, token = null, serviceRoleKey }: TestClientOptions): SupatypeClient {
  return createClient({
    url,
    anonKey: "anon-key",
    ...(serviceRoleKey !== undefined && { serviceRoleKey }),
    ...(token !== null && { initialSession: sessionFor(token) }),
    auth: { persistSession: false, detectSessionInUrl: false },
  })
}

/** A field with the defaults the engine writes, plus whatever the test sets. */
export function testField(over: Partial<FieldConfig> & Pick<FieldConfig, "name">): FieldConfig {
  return { label: over.name, widget: "text", required: false, localized: false, ...over }
}

/** A plain model named `post` with no fields, versions or flags, plus whatever the test sets. */
export function testModel(over: Partial<ModelConfig> = {}): ModelConfig {
  return {
    name: "post",
    label: "Post",
    labelPlural: "Posts",
    tableName: "posts",
    apiPath: "/rest/v1/posts",
    primaryKey: "id",
    fields: [],
    listColumns: [],
    searchFields: [],
    publishable: false,
    versions: null,
    softDelete: false,
    timestamps: false,
    hasHooks: false,
    ...over,
  }
}

/** A config with no models, globals or navigation, plus whatever the test sets. */
export function testConfig(over: Partial<AdminConfig> = {}): AdminConfig {
  return { models: [], globals: [], navigation: [], ...over }
}

function unused(method: string): () => Promise<never> {
  return () => Promise.reject(new Error(`ProjectProxy.${method} was not expected in this test`))
}

/** A project proxy whose every method fails loudly unless the test supplies it. */
export function testProxy(over: Partial<ProjectProxy> = {}): ProjectProxy {
  return {
    sql: unused("sql"),
    metadata: unused("metadata"),
    introspect: unused("introspect"),
    schemas: unused("schemas"),
    studioExtension: unused("studioExtension"),
    studioRls: unused("studioRls"),
    studioPolicy: unused("studioPolicy"),
    ...over,
  }
}

const isMetadataBody = isShape({ name: optional(isString), params: optional(isRecordOf(isUnknown)) })

/** The body of a named metadata read (`{ name, params }`). */
export type MetadataBody = { name?: string; params?: Record<string, unknown> }

/** A metadata request's body; anything that is not one reads as `{}`, which names no query. */
export function metadataBody(init?: RequestInit): MetadataBody {
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : {}
  return isMetadataBody(body) ? body : {}
}

/** The element `selector` finds, checked to be a `type`; throws naming what was there instead. */
export function elementOf<T extends Element>(
  root: ParentNode,
  selector: string,
  type: abstract new () => T,
): T {
  const el = root.querySelector(selector)
  if (!(el instanceof type)) {
    throw new Error(`expected ${type.name} at "${selector}", found ${el === null ? "nothing" : el.tagName}`)
  }
  return el
}

/**
 * The button in `scope` whose text, or failing that whose aria-label, reads exactly `text`, or
 * undefined when there is none.
 */
export function findButton(scope: ParentNode, text: string): HTMLButtonElement | undefined {
  return Array.from(scope.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text || b.getAttribute("aria-label") === text,
  )
}

/** The button `findButton` finds; throws naming it when there is none. */
export function button(scope: ParentNode, text: string): HTMLButtonElement {
  const found = findButton(scope, text)
  if (!found) throw new Error(`no "${text}" button`)
  return found
}

/** A timer vitest can put on its virtual clock. */
type VirtualTimer = NonNullable<NonNullable<Parameters<typeof vi.useFakeTimers>[0]>["toFake"]>[number]

/**
 * Bumped as each test starts and again as it ends, so work a test started can tell that the test
 * is over. A test that times out keeps running after vitest has moved on.
 */
let phase = 0

/** The name of the test that is running, or that last ran, for errors raised after it ended. */
let currentTest = "a test"

/** How long the end of a test waits for an act it left open, well inside vitest's 10s hook timeout. */
const ACT_CLOSE_DEADLINE_MS = 8000

/**
 * React's act, guarded: once the act is done, a test that has since ended (it timed out and
 * vitest moved on) stops here instead of clicking and asserting on the next test's page. Test
 * files that call `isolateEachTest()` import this rather than React's own.
 */
export async function act(work: () => unknown): Promise<void> {
  const started = phase
  await reactAct(async () => { await work() })
  if (phase !== started) throw new Error(`"${currentTest}" ran on after it ended`)
}

/**
 * Whether an act scope is open in `react`. React keeps no public way to ask, so this reads the act
 * queue its internals hold from the start of the outermost act to the end of its flush. It throws
 * when those internals are missing, so a React upgrade that moves them fails here, loudly, instead
 * of quietly turning the wait in `isolateEachTest` into a no-op.
 */
export function actScopeOpenIn(react: object): boolean {
  const internals: unknown = Reflect.get(react, "__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE")
  if (typeof internals !== "object" || internals === null || !("actQueue" in internals)) {
    throw new Error("React's internals hold no act queue: isolateEachTest cannot tell whether an act is open")
  }
  const queue: unknown = Reflect.get(internals, "actQueue")
  return queue !== null && queue !== undefined
}

/**
 * Resolves once no act scope is open. React keeps one count of open act scopes for the whole file.
 * A timed-out test's act, still open when the next test opened its own, closed out of order and
 * left the count one too high, after which React flushed no render in that file again and every
 * later test failed. Waiting here, before the next test starts, keeps the two from overlapping.
 * An act still open after `withinMs` throws, naming the test that left it open.
 */
export async function actScopesClosed(react: object = React, withinMs = ACT_CLOSE_DEADLINE_MS): Promise<void> {
  const deadline = performance.now() + withinMs
  while (actScopeOpenIn(react)) {
    if (performance.now() > deadline) {
      throw new Error(`"${currentTest}" left an act open that did not close within ${withinMs}ms`)
    }
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/**
 * Moves the virtual clock on by `ms`, `turns` times, each inside act, so a debounce that fires,
 * the request it starts and the render that answer causes all land before the test looks.
 */
export async function advance(ms = 0, turns = 3): Promise<void> {
  if (!vi.isFakeTimers()) {
    throw new Error("advance and settle run on the virtual clock: call isolateEachTest() at the top of this test file")
  }
  for (let i = 0; i < turns; i++) await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

/** Lets the requests in flight answer and the renders they cause land, on the virtual clock. */
export async function settle(turns = 4): Promise<void> {
  await advance(0, turns)
}

/** A view a test mounted: its own container on document.body and the root rendering into it. */
export interface Mounted {
  container: HTMLElement
  root: Root
}

const mounted: Mounted[] = []

/**
 * Renders `ui` into a new container on document.body, through a root of its own. A root shared
 * through the file's module scope let a test that timed out render into, and assert against, the
 * next test's view. `isolateEachTest` unmounts these after each test.
 */
export async function mount(ui: ReactElement): Promise<Mounted> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement("div")
  document.body.appendChild(container)
  const view = { container, root: createRoot(container) }
  mounted.push(view)
  await act(() => { view.root.render(ui) })
  return view
}

/** Unmounts `view` and removes its container, for a test that is done with it before it ends. */
export function unmount(view: Mounted): void {
  // By root, since a harness spreads the view into an object of its own.
  const at = mounted.findIndex((m) => m.root === view.root)
  if (at >= 0) mounted.splice(at, 1)
  reactAct(() => view.root.unmount())
  view.container.remove()
}

/**
 * Runs each of the file's tests on the virtual clock (setTimeout plus any `extra` timers) and,
 * after each, waits for any act it left open to close, unmounts what it mounted, and restores
 * the globals it stubbed and the real clock. On the virtual clock a debounce or a settle is
 * passed by moving the clock, not by sleeping: a real `setTimeout(0)` waits for the next timer
 * tick, about 15ms on Windows and longer on a loaded machine.
 */
export function isolateEachTest(...extra: VirtualTimer[]): void {
  beforeEach(() => {
    phase++
    currentTest = expect.getState().currentTestName ?? "a test"
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", ...extra] })
  })
  afterEach(async () => {
    phase++
    try {
      await actScopesClosed()
    } finally {
      for (const view of [...mounted]) unmount(view)
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })
}
