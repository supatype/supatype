/**
 * A Ctrl+C typed while a prompt holds the terminal in raw mode reaches the prompt as a key, never the
 * process as SIGINT. Ink used to end the process on it, exit 0: a Ctrl+C on dev's "Save port" prompt
 * skipped the start-time stop, and Postgres was cut off mid shutdown with its postmaster.pid left
 * behind (local test round 7, N32). It is handed on as the signal it would have been instead.
 */

/**
 * The Ctrl+C a prompt read, as the process's own SIGINT: a command listening for one (dev, which
 * stops what its start began and waits for it) hears it. Any other command ends as an interrupted
 * command does, with 130.
 */
export function interruptFromPrompt(): void {
  if (process.listenerCount("SIGINT") > 0) {
    process.emit("SIGINT", "SIGINT")
    return
  }
  process.exit(130)
}
