import React, { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, vi } from "vitest"
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

/** A timer vitest can put on its virtual clock. */
type VirtualTimer = NonNullable<NonNullable<Parameters<typeof vi.useFakeTimers>[0]>["toFake"]>[number]

/**
 * Puts setTimeout, and any `extra` timers, on a virtual clock for the rest of the test, so a
 * debounce or a settle is passed by moving the clock rather than by sleeping through it. A real
 * `setTimeout(0)` waits for the next timer tick, about 15ms on Windows and longer on a loaded
 * machine, and a test that settles a few dozen times spends that on top of its rendering. Undo it
 * with `vi.useRealTimers()` in `afterEach`, or let `isolateEachTest` do both.
 */
export function useVirtualTimeouts(...extra: VirtualTimer[]): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", ...extra] })
}

/**
 * Bumped as each test starts and again as it ends, so work a test started can tell that the test
 * is over. A test that times out keeps running after vitest has moved on.
 */
let phase = 0

/** Runs `work` inside act, then stops the test that started it if that test has since ended. */
async function actFor(started: number, work: () => Promise<void>): Promise<void> {
  await act(work)
  if (phase !== started) throw new Error("a test that timed out ran on after it ended")
}

/**
 * Whether an act scope is open. React keeps no public way to ask, so this reads the act queue its
 * internals hold from the start of the outermost act to the end of its flush.
 */
function actScopeOpen(): boolean {
  const internals: unknown = Reflect.get(React, "__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE")
  if (typeof internals !== "object" || internals === null) return false
  const queue: unknown = Reflect.get(internals, "actQueue")
  return queue !== null && queue !== undefined
}

/**
 * Resolves once no act scope is open. React keeps one count of open act scopes for the whole file.
 * A timed-out test's act, still open when the next test opened its own, closed out of order and
 * left the count one too high, after which React flushed no render in that file again and every
 * later test failed. Waiting here, before the next test starts, keeps the two from overlapping.
 */
async function actScopesClosed(): Promise<void> {
  while (actScopeOpen()) await new Promise((resolve) => setImmediate(resolve))
}

/**
 * Moves the virtual clock on by `ms`, `turns` times, each inside act, so a debounce that fires,
 * the request it starts and the render that answer causes all land before the test looks.
 */
export async function advance(ms = 0, turns = 3): Promise<void> {
  const started = phase
  for (let i = 0; i < turns; i++) await actFor(started, async () => { await vi.advanceTimersByTimeAsync(ms) })
}

/** Lets the requests in flight answer and the renders they cause land, on the virtual clock. */
export async function settle(): Promise<void> {
  await advance(0, 4)
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
 * next test's view. `unmountAll` takes these down.
 */
export async function mount(ui: ReactElement): Promise<Mounted> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement("div")
  document.body.appendChild(container)
  const view = { container, root: createRoot(container) }
  mounted.push(view)
  await actFor(phase, async () => { view.root.render(ui) })
  return view
}

/** Unmounts `view` and removes its container; unmounting it again does nothing. */
export function unmount(view: Mounted): void {
  act(() => view.root.unmount())
  view.container.remove()
}

/** Unmounts every view `mount` rendered and removes its container. */
export function unmountAll(): void {
  for (const view of mounted.splice(0)) unmount(view)
}

/**
 * Runs each of the file's tests on the virtual clock (setTimeout plus any `extra` timers) and,
 * after each, waits for any act it left open to close, unmounts what it mounted, and restores
 * the globals it stubbed and the real clock.
 */
export function isolateEachTest(...extra: VirtualTimer[]): void {
  beforeEach(() => {
    phase++
    useVirtualTimeouts(...extra)
  })
  afterEach(async () => {
    phase++
    await actScopesClosed()
    unmountAll()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })
}
