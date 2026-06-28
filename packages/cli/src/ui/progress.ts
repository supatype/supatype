/**
 * Progress UI for one-shot commands — Ink spinner inside command chrome.
 */

import { getActiveFlowApi } from "./runtime/flow-session.js"
import { isInteractive } from "./interactive.js"
import { info } from "./messages.js"
import { runCommandChrome } from "./runtime/command-chrome.js"

/**
 * Show progress with the branded Ink spinner when command chrome is active
 * (or mount chrome for a standalone spinner).
 */
export async function withSpinner<T>(
  message: string,
  task: () => Promise<T>,
  doneMessage?: string,
): Promise<T> {
  if (!isInteractive()) {
    info(`${message}...`)
    return task()
  }

  const api = getActiveFlowApi()
  if (!api) {
    return runCommandChrome(() => withSpinner(message, task, doneMessage))
  }

  const spinner = api.spinner()
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
