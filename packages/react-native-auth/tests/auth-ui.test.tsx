import React from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { create, act } from "react-test-renderer"
import type { Session } from "@supatype/client"

const signIn = vi.fn()
const signUp = vi.fn()
const signInWithOtp = vi.fn()
const resetPasswordForEmail = vi.fn()
const updateUser = vi.fn()
const getSession = vi.fn()
const openOAuth = vi.fn()

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
      findByTestId(tree!, "st-login-email").props.onChangeText("a@b.com")
      findByTestId(tree!, "st-login-password").props.onChangeText("secret")
    })
    await act(async () => {
      findByTestId(tree!, "st-login-submit").props.onPress()
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
      findByTestId(tree!, "st-signup-email").props.onChangeText("a@b.com")
      findByTestId(tree!, "st-signup-password").props.onChangeText("secret12")
      findByTestId(tree!, "st-signup-submit").props.onPress()
    })
    expect(tree!.root.findAllByType("Text").some((n) =>
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
      findByTestId(tree!, "st-magic-link-email").props.onChangeText("a@b.com")
    })
    await act(async () => {
      findByTestId(tree!, "st-magic-link-submit").props.onPress()
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
      findByTestId(tree!, "st-oauth-google").props.onPress()
    })
    expect(openOAuth).toHaveBeenCalled()
    expect(onSuccess).toHaveBeenCalledWith(SESSION)
  })

  it("ResetPassword request mode calls recover", async () => {
    resetPasswordForEmail.mockResolvedValue({ data: {}, error: null })
    let tree: ReturnType<typeof create>
    await act(async () => {
      tree = create(<ResetPassword redirectTo="myapp://reset" />)
    })
    await act(async () => {
      findByTestId(tree!, "st-reset-email").props.onChangeText("a@b.com")
    })
    await act(async () => {
      findByTestId(tree!, "st-reset-submit").props.onPress()
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
    expect(tree!.root.findByType("Fallback")).toBeTruthy()
  })
})

function TextStub(): React.ReactElement {
  return React.createElement("Fallback", null, "login")
}
function ViewStub(): React.ReactElement {
  return React.createElement("Home", null, "home")
}
