import React from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { create, act } from "react-test-renderer"
import type { Session } from "@supatype/client"
import { Text } from "react-native"

const signIn = vi.fn()
const signUp = vi.fn()
const signInWithOtp = vi.fn()
const resetPasswordForEmail = vi.fn()
const updateUser = vi.fn()
const getSession = vi.fn()
const openOAuth = vi.fn<(...args: unknown[]) => Promise<unknown>>()

vi.mock("@supatype/react", () => ({
  useAuth: () => ({
    user: null,
    session: null,
    loading: false,
    signIn,
    signUp,
    signInWithOtp,
    signInWithOAuth: vi.fn(),
    signOut: vi.fn(),
  }),
  useSupatype: () => ({
    auth: {
      resetPasswordForEmail,
      updateUser,
      getSession,
      signInWithOAuth: vi.fn(),
      getSessionFromUrl: vi.fn(),
    },
  }),
}))

vi.mock("@supatype/react-native", () => ({
  openOAuth: (...args: unknown[]) => openOAuth(...args),
}))

import { AuthGate } from "../src/AuthGate.js"
import { LoginForm } from "../src/LoginForm.js"
import { MagicLinkForm } from "../src/MagicLinkForm.js"
import { OAuthButton } from "../src/OAuthButton.js"
import { ResetPassword } from "../src/ResetPassword.js"
import { SignUpForm } from "../src/SignUpForm.js"

const SESSION: Session = {
  accessToken: "at",
  refreshToken: "rt",
  tokenType: "bearer",
  expiresIn: 3600,
  user: {
    id: "u1",
    email: "a@b.com",
    appMetadata: {},
    userMetadata: {},
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  },
}

function findByTestId(root: ReturnType<typeof create>, testID: string) {
  return root.root.findByProps({ testID })
}

/** A prop that is a function: what it is called with is the test's to choose. */
function isHandler(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === "function"
}

/** The node's `prop` handler, which the test renderer types as `any`, checked to be a function. */
function handler(root: ReturnType<typeof create>, testID: string, prop: string): (...args: unknown[]) => unknown {
  const value: unknown = findByTestId(root, testID).props[prop]
  if (!isHandler(value)) throw new Error(`${testID} has no ${prop} handler`)
  return value
}

function changeText(root: ReturnType<typeof create>, testID: string, text: string): void {
  handler(root, testID, "onChangeText")(text)
}

function press(root: ReturnType<typeof create>, testID: string): void {
  handler(root, testID, "onPress")()
}

describe("@supatype/react-native-auth", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("LoginForm calls signIn and onSuccess", async () => {
    signIn.mockResolvedValue({ data: { session: SESSION, user: SESSION.user }, error: null })
    const onSuccess = vi.fn()
    let tree: ReturnType<typeof create>
    await act(async () => {
      tree = create(<LoginForm onSuccess={onSuccess} />)
    })

    await act(async () => {
      changeText(tree!, "st-login-email", "a@b.com")
      changeText(tree!, "st-login-password", "secret")
    })
    await act(async () => {
      press(tree!, "st-login-submit")
    })

    expect(signIn).toHaveBeenCalledWith({ email: "a@b.com", password: "secret" })
    expect(onSuccess).toHaveBeenCalledWith(SESSION)
  })

  it("SignUpForm shows confirmation when session is null", async () => {
    signUp.mockResolvedValue({ data: { session: null, user: null }, error: null })
    let tree: ReturnType<typeof create>
    await act(async () => {
      tree = create(<SignUpForm />)
    })
    await act(async () => {
      changeText(tree!, "st-signup-email", "a@b.com")
      changeText(tree!, "st-signup-password", "secret12")
      press(tree!, "st-signup-submit")
    })
    expect(tree!.root.findAllByType(Text).some((n) =>
      String(n.props.children).includes("Check your email"),
    )).toBe(true)
  })

  it("MagicLinkForm sends OTP", async () => {
    signInWithOtp.mockResolvedValue({ data: {}, error: null })
    let tree: ReturnType<typeof create>
    await act(async () => {
      tree = create(<MagicLinkForm redirectTo="myapp://auth/callback" />)
    })
    await act(async () => {
      changeText(tree!, "st-magic-link-email", "a@b.com")
    })
    await act(async () => {
      press(tree!, "st-magic-link-submit")
    })
    expect(signInWithOtp).toHaveBeenCalledWith({
      email: "a@b.com",
      options: { emailRedirectTo: "myapp://auth/callback" },
    })
    expect(findByTestId(tree!, "st-magic-link-sent")).toBeTruthy()
  })

  it("OAuthButton calls openOAuth with PKCE helper", async () => {
    openOAuth.mockResolvedValue({
      data: { session: SESSION, user: SESSION.user },
      error: null,
      cancelled: false,
    })
    const onSuccess = vi.fn()
    const webBrowser = { openAuthSessionAsync: vi.fn() }
    let tree: ReturnType<typeof create>
    await act(async () => {
      tree = create(
        <OAuthButton
          provider="google"
          redirectTo="myapp://cb"
          webBrowser={webBrowser}
          onSuccess={onSuccess}
        />,
      )
    })
    await act(async () => {
      press(tree!, "st-oauth-google")
    })
    expect(openOAuth).toHaveBeenCalled()
    expect(onSuccess).toHaveBeenCalledWith(SESSION)
  })

  it("OAuthButton announces the label it shows", async () => {
    const webBrowser = { openAuthSessionAsync: vi.fn() }
    let tree: ReturnType<typeof create>
    await act(async () => {
      tree = create(
        <OAuthButton provider="keycloak" redirectTo="myapp://cb" webBrowser={webBrowser}>
          Sign in with Mock SSO
        </OAuthButton>,
      )
    })
    expect(findByTestId(tree!, "st-oauth-keycloak").props.accessibilityLabel).toBe("Sign in with Mock SSO")
  })

  it("ResetPassword request mode calls recover", async () => {
    resetPasswordForEmail.mockResolvedValue({ data: {}, error: null })
    let tree: ReturnType<typeof create>
    await act(async () => {
      tree = create(<ResetPassword redirectTo="myapp://reset" />)
    })
    await act(async () => {
      changeText(tree!, "st-reset-email", "a@b.com")
    })
    await act(async () => {
      press(tree!, "st-reset-submit")
    })
    expect(resetPasswordForEmail).toHaveBeenCalledWith("a@b.com", { redirectTo: "myapp://reset" })
    expect(findByTestId(tree!, "st-reset-sent")).toBeTruthy()
  })

  it("AuthGate renders fallback when signed out", async () => {
    let tree: ReturnType<typeof create>
    await act(async () => {
      tree = create(
        <AuthGate fallback={<TextStub />}>
          <ViewStub />
        </AuthGate>,
      )
    })
    expect(tree!.root.findByType(TextStub)).toBeTruthy()
  })
})

function TextStub(): React.ReactElement {
  return React.createElement("Fallback", null, "login")
}
function ViewStub(): React.ReactElement {
  return React.createElement("Home", null, "home")
}
