/**
 * An auth form over a client that has no API address or anon key.
 *
 * The client throws `MissingClientValuesError` from the request rather than turning it into a
 * result, so an app that reads only `data` cannot miss it. A form must still show it and stop
 * loading: it used to hang on its spinner, with the error only as an unhandled rejection.
 */

import React from "react"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createClient, MissingClientValuesError, type SupatypeError } from "@supatype/client"
import { SupatypeProvider } from "@supatype/react"
import { LoginForm, SignUpForm } from "../src/index.js"
import { submit, textOf, type } from "./helpers.js"

const unhandled: unknown[] = []
const record = (reason: unknown): void => { unhandled.push(reason) }

beforeEach(() => {
  unhandled.length = 0
  process.on("unhandledRejection", record)
})

afterEach(() => {
  process.off("unhandledRejection", record)
  vi.unstubAllGlobals()
})

/** Render `ui` over a client given neither value, on a page that set none. */
function renderUnconfigured(ui: React.ReactElement): ReactTestRenderer {
  const client = createClient({})
  let renderer: ReactTestRenderer | null = null
  act(() => { renderer = create(<SupatypeProvider client={client}>{ui}</SupatypeProvider>) })
  return renderer!
}

/** Whether every button in the form is enabled again, as it is once loading has ended. */
function buttonsEnabled(renderer: ReactTestRenderer): boolean {
  return renderer.root.findAllByType("button").every((button) => button.props["disabled"] !== true)
}

describe("an auth form over a client with no address or anon key", () => {
  it.each([
    ["LoginForm", (onError: (e: SupatypeError) => void) => <LoginForm onError={onError} />, "st-login"],
    ["SignUpForm", (onError: (e: SupatypeError) => void) => <SignUpForm onError={onError} />, "st-signup"],
  ])("%s shows the setup error and stops loading", async (_name, form, prefix) => {
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    const onError = vi.fn()
    const renderer = renderUnconfigured(form(onError))

    type(renderer, `${prefix}-email`, "ada@example.com")
    type(renderer, `${prefix}-password`, "secret-pass")
    await submit(renderer)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

    expect(textOf(renderer.root.findByProps({ role: "alert" }))).toContain("no API address and anon key")
    const reported: unknown = onError.mock.calls[0]?.[0]
    expect(typeof reported === "object" && reported !== null ? Reflect.get(reported, "message") : undefined).toMatch(/SUPATYPE_URL/)
    expect(buttonsEnabled(renderer)).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(unhandled.filter((reason) => reason instanceof MissingClientValuesError)).toEqual([])
  })
})
