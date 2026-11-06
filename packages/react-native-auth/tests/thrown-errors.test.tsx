/**
 * A form whose auth request throws instead of answering `{ data, error }` shows the error, hands it
 * to `onError`, stops loading and reports it once to the console, with no unhandled rejection.
 *
 * Some faults are thrown on purpose: a client with no API address or anon key throws from its first
 * request. The forms only had `try`/`finally`, so the button came back but the form said nothing.
 */

import React from "react"
import { afterEach, describe, it, expect, vi, type MockInstance } from "vitest"
import { MissingClientValuesError } from "@supatype/client"
import { create, act, type ReactTestRenderer } from "react-test-renderer"
import { Text } from "react-native"

const signIn = vi.fn()
const signUp = vi.fn()
const signInWithOtp = vi.fn()
const resetPasswordForEmail = vi.fn()
const updateUser = vi.fn()
const getSession = vi.fn()

vi.mock("@supatype/react", () => ({
  useAuth: () => ({ user: null, session: null, loading: false, signIn, signUp, signInWithOtp }),
  useSupatype: () => ({ auth: { resetPasswordForEmail, updateUser, getSession } }),
}))

vi.mock("@supatype/react-native", () => ({ openOAuth: vi.fn() }))

import { LoginForm } from "../src/LoginForm.js"
import { MagicLinkForm } from "../src/MagicLinkForm.js"
import { ResetPassword } from "../src/ResetPassword.js"
import { SignUpForm } from "../src/SignUpForm.js"

/** The setup fault a client with no address throws: one of the SDK's errors, held as it is. */
class SetupFault extends MissingClientValuesError {
  constructor() {
    super("Supatype client has no API address", ["url"])
    this.name = "SetupFault"
  }
}

/** The node's `prop`, checked to be a function: the test renderer types props as `any`. */
function handler(tree: ReactTestRenderer, testID: string, prop: string): (...args: unknown[]) => unknown {
  const value: unknown = tree.root.findByProps({ testID }).props[prop]
  if (typeof value !== "function") throw new Error(`${testID} has no ${prop} handler`)
  return (...args: unknown[]): unknown => Reflect.apply(value, undefined, args)
}

function shows(tree: ReactTestRenderer, text: string): boolean {
  return tree.root.findAllByType(Text).some((node) => String(node.props.children).includes(text))
}

function reportsOf(logged: MockInstance<typeof console.error>, thrown: unknown): number {
  return logged.mock.calls.filter((call) => call.includes(thrown)).length
}

interface FormCase {
  name: string
  render: (onError: (error: unknown) => void) => React.ReactElement
  fill: Record<string, string>
  submit: string
  failing: ReturnType<typeof vi.fn>
}

const CASES: FormCase[] = [
  { name: "LoginForm", render: (onError) => <LoginForm onError={onError} />, fill: { "st-login-email": "a@b.com", "st-login-password": "secret" }, submit: "st-login-submit", failing: signIn },
  { name: "SignUpForm", render: (onError) => <SignUpForm onError={onError} />, fill: { "st-signup-email": "a@b.com", "st-signup-password": "secret12" }, submit: "st-signup-submit", failing: signUp },
  { name: "MagicLinkForm", render: (onError) => <MagicLinkForm onError={onError} />, fill: { "st-magic-link-email": "a@b.com" }, submit: "st-magic-link-submit", failing: signInWithOtp },
  { name: "ResetPassword request", render: (onError) => <ResetPassword onError={onError} />, fill: { "st-reset-email": "a@b.com" }, submit: "st-reset-submit", failing: resetPasswordForEmail },
  { name: "ResetPassword update", render: (onError) => <ResetPassword mode="update" onError={onError} />, fill: { "st-reset-password": "new-secret" }, submit: "st-reset-submit", failing: updateUser },
]

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

/** The form rendered, filled in and submitted. */
async function submitted(form: FormCase, onError: (error: unknown) => void): Promise<ReactTestRenderer> {
  let tree: ReactTestRenderer | null = null
  await act(async () => {
    tree = create(form.render(onError))
  })
  if (tree === null) throw new Error("nothing rendered")
  const rendered: ReactTestRenderer = tree
  await act(async () => {
    for (const [testID, text] of Object.entries(form.fill)) handler(rendered, testID, "onChangeText")(text)
  })
  await act(async () => {
    handler(rendered, form.submit, "onPress")()
  })
  return rendered
}

describe.each(CASES)("$name", (form) => {
  it("shows a thrown error, hands it to onError, stops loading and reports it once", async () => {
    const thrown = new SetupFault()
    form.failing.mockRejectedValue(thrown)
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const onError = vi.fn()
    const rendered = await submitted(form, onError)

    expect(shows(rendered, "Supatype client has no API address")).toBe(true)
    expect(onError).toHaveBeenCalledWith(thrown)
    expect(rendered.root.findByProps({ testID: form.submit }).props.disabled).toBe(false)
    expect(reportsOf(logged, thrown)).toBe(1)
  })

  it("still shows a returned refusal, unreported", async () => {
    const refusal = { message: "Invalid login credentials" }
    form.failing.mockResolvedValue({ data: null, error: refusal })
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const onError = vi.fn()
    const rendered = await submitted(form, onError)

    expect(shows(rendered, "Invalid login credentials")).toBe(true)
    expect(onError).toHaveBeenCalledWith(refusal)
    expect(logged).not.toHaveBeenCalled()
  })
})
