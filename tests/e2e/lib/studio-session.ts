/**
 * Signing in to Studio, once, for every spec that needs it.
 *
 * Four specs each carried their own copy of this, three of them identical bar a comment. The one
 * that ran first, `function-logs` by alphabetical order and nothing else, was the one that
 * intermittently failed on a cold stack, waiting thirty seconds for a session that never arrived
 * while the same sign-in took under two seconds on a warm one. The other three passed because by
 * the time they ran, Studio was warm and the first spec had already paid the cost.
 *
 * The click is retried rather than the wait being lengthened. A longer wait assumes the sign-in is
 * in flight and slow; the evidence says otherwise, because when the request is observed at all it
 * returns in milliseconds. What fits is a first click that lands before the handler behind it is
 * live and is silently dropped: no request, no error, nothing to wait for. `studio.spec.ts` had
 * already noticed the shape of this, and says so where it asserts the form is gone rather than
 * that the click happened, "the only reliable signal that the session was accepted rather than the
 * click simply doing nothing".
 *
 * Retrying also covers the other candidate, a session written and then cleared, because the next
 * attempt simply writes it again. It is deliberately not asserted which one it is: the cause was
 * never caught in the act, and a comment claiming a mechanism nobody observed is worse than one
 * that says what was measured.
 */
import { expect, type Page } from "@playwright/test"

/** Where both of Studio's auth clients keep the session. */
export const STUDIO_SESSION_KEY = "supatype.auth.session"

export interface StudioCredentials {
  email: string
  password: string
  /** False when the caller has already navigated, so the page is not loaded twice. */
  navigate?: boolean
}

/** Whether a session is in storage right now, without waiting for one. */
async function hasSession(page: Page): Promise<boolean> {
  return page
    .evaluate((key) => localStorage.getItem(key) !== null, STUDIO_SESSION_KEY)
    .catch(() => false)
}

/**
 * Sign in and do not return until the session is in storage.
 *
 * Stored rather than merely requested, because navigating between those two moments loses it and
 * every later view then shows the sign-in page, which reads as a broken view rather than a lost
 * session.
 */
export async function signInToStudio(page: Page, credentials: StudioCredentials): Promise<void> {
  const { email, password, navigate = true } = credentials
  if (navigate) await page.goto("/studio/", { waitUntil: "networkidle" })

  const attempts = 3
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (await hasSession(page)) return

    const submit = page.getByRole("button", { name: /sign in/i })
    // Absent means the form has gone, which happens when a previous attempt was accepted after
    // its wait expired. The session check at the top of the next pass settles it.
    if (await submit.isVisible().catch(() => false)) {
      await page.getByLabel(/email/i).fill(email)
      await page.getByLabel(/password/i).fill(password)
      await submit.click()
    }

    try {
      await page.waitForFunction(
        (key) => localStorage.getItem(key) !== null,
        STUDIO_SESSION_KEY,
        { timeout: 10_000 },
      )
      return
    } catch {
      // Falls through to another attempt. The last one reports rather than swallowing.
      if (attempt === attempts) {
        expect(
          await hasSession(page),
          `no Studio session after ${attempts} sign-in attempts as ${email}`,
        ).toBe(true)
      }
    }
  }
}
