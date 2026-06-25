import * as p from "@clack/prompts"
import { isInteractive } from "./interactive.js"
import { info } from "./messages.js"

/**
 * Run an async task with a Clack spinner (TTY) or a plain status line (CI/pipes).
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

  const spinner = p.spinner()
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
