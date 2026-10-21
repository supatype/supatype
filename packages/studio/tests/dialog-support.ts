import { act, button, settle } from "./support.js"

/**
 * Helpers for the questions Studio asks before a destructive act, shared by the suites that check
 * an act waits for its answer.
 */

/** The open alertdialog's text, or null when nothing is being asked. */
export function asking(): string | null {
  return document.body.querySelector('[role="alertdialog"]')?.textContent ?? null
}

/**
 * Clicks the button whose text, or failing that whose aria-label, reads exactly `label`, inside
 * `scope` (the whole page by default), and lets the page settle. Throws when there is none.
 */
export async function press(label: string, scope: ParentNode = document.body): Promise<void> {
  const found = button(scope, label)
  await act(() => found.click())
  await settle()
}
