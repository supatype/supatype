import React from "react"
import { describe, it, expect, vi } from "vitest"
import { create, type ReactTestInstance } from "react-test-renderer"
import { LoginForm, OAuthButton, SignUpForm, type AuthFormClassNames } from "../src/index.js"
import { DEFAULT_ERROR_STYLE, errorProps } from "../src/classNames.js"

vi.mock("@supatype/react", () => ({
  useAuth: () => ({ signIn: vi.fn(), signUp: vi.fn(), signInWithOAuth: vi.fn() }),
}))

const classNames: AuthFormClassNames = {
  title: "t-title",
  field: "t-field",
  label: "t-label",
  input: "t-input",
  submit: "t-submit",
}

function classesOf(root: ReactTestInstance, type: string): Array<string | undefined> {
  return root.findAllByType(type).map((node) => node.props["className"] as string | undefined)
}

describe.each([
  ["LoginForm", LoginForm],
  ["SignUpForm", SignUpForm],
] as const)("%s classNames", (_name, Form) => {
  it("puts each slot's class on the element it names", () => {
    const root = create(<Form className="t-form" classNames={classNames} />).root
    expect(classesOf(root, "form")).toEqual(["t-form"])
    expect(classesOf(root, "h2")).toEqual(["t-title"])
    expect(classesOf(root, "div")).toEqual(["t-field", "t-field"])
    expect(classesOf(root, "label")).toEqual(["t-label", "t-label"])
    expect(classesOf(root, "input")).toEqual(["t-input", "t-input"])
    expect(classesOf(root, "button")).toEqual(["t-submit"])
  })

  it("leaves the markup unclassed when no classNames are given", () => {
    const root = create(<Form />).root
    expect(classesOf(root, "input")).toEqual([undefined, undefined])
  })
})

describe("errorProps", () => {
  it("gives the error the app's class and no inline colour when a class is set", () => {
    expect(errorProps({ error: "t-error" })).toEqual({ className: "t-error" })
  })

  it("falls back to a red message when the app sets no class", () => {
    expect(errorProps(undefined)).toEqual({ style: DEFAULT_ERROR_STYLE })
  })
})

describe("OAuthButton", () => {
  it("spells a provider the way the provider does", () => {
    const root = create(<OAuthButton provider="github" />).root
    expect(root.findByType("button").props["aria-label"]).toBe("Sign in with GitHub")
  })
})
