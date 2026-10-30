/**
 * Progress UI for one-shot commands, Ink spinner inside command chrome.
 */

import { getActiveFlowApi } from "./runtime/flow-session.js"
import { isInteractive } from "./interactive.js"
import { info } from "./messages.js"
import { runCommandChrome } from "./runtime/command-chrome.js"
import type { ClackSpinner } from "./clack-api.js"

/**
 * Show progress with the branded Ink spinner when command chrome is active
 * (or mount chrome for a standalone spinner).
 */
export async function withSpinner<T>(
  message: string,
  task: () => Promise<T>,
  doneMessage?: string,
): Promise<T> {
  return withProgressView(async (spinner) => {
    if (spinner === undefined) {
      info(`${message}...`)
      return task()
    }
    return spinning(spinner, message, task, doneMessage)
  })
}

/**
 * Run `task` with the spinner progress is shown on: the active flow's when one is up, the command
 * chrome's, mounted for it, when none is, and none at all off a terminal. `withSpinner` and init's
 * setup steps (init-setup-steps.ts) both decide here, so neither starts a second spinner.
 */
export async function withProgressView<T>(task: (spinner: ClackSpinner | undefined) => Promise<T>): Promise<T> {
  if (!isInteractive()) return task(undefined)
  const api = getActiveFlowApi()
  if (!api) return runCommandChrome(() => withProgressView(task))
  return task(api.spinner())
}

/** `task` with `spinner` showing `message`, stopped with `doneMessage` or "Failed". */
async function spinning<T>(spinner: ClackSpinner, message: string, task: () => Promise<T>, doneMessage?: string): Promise<T> {
  spinner.start(message)
  try {
    const result = await task()
    spinner.stop(doneMessage ?? message)
    return result
  } catch (err) {
    spinner.stop("Failed")
    throw err
  }
}
