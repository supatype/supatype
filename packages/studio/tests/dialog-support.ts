import { act } from "react"
import { settle } from "./data-browser-support.js"

/**
 * Helpers for the questions Studio asks before a destructive act, shared by the suites that check
 * an act waits for its answer.
 */

/** The open alertdialog's text, or null when nothing is being asked. */
export function asking(): string | null {
  return document.body.querySelector('[role="alertdialog"]')?.textContent ?? null
}

/** Clicks the button reading exactly `label`, anywhere on the page, and lets the page settle. */
export async function press(label: string): Promise<void> {
  const found = Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent?.trim() === label)
  if (!found) throw new Error(`no "${label}" button`)
  await act(async () => found.click())
  await settle()
}
