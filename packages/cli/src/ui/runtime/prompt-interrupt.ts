/**
 * A Ctrl+C typed while a prompt holds the terminal in raw mode reaches the prompt as a key, never the
 * process as SIGINT. Ink used to end the process on it, exit 0: a Ctrl+C on dev's "Save port" prompt
 * skipped the start-time stop, and Postgres was cut off mid shutdown with its postmaster.pid left
 * behind (local test round 7, N32).
 */
import { devShutdownHooksRegistered, requestDevShutdown } from "../../dev-shutdown.js"

/**
 * The Ctrl+C a prompt read, as the command's own. Under `supatype dev` it is dev's Ctrl+C: during
 * its start that stops what the start began and waits for it. Through requestDevShutdown, which
 * ignores the SIGINT a Windows terminal may send beside the key: taken as a second Ctrl+C, it
 * force-quit the shutdown. Any other command ends as an interrupted one does, with 130, once
 * `release` has given the terminal back: a SIGINT listener that is not the CLI's own (signal-exit,
 * a child's forwarding) would leave the prompt waiting in raw mode forever.
 */
export function interruptFromPrompt(release: () => void): void {
  if (devShutdownHooksRegistered()) {
    requestDevShutdown()
    return
  }
  release()
  process.exit(130)
}
