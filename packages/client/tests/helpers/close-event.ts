/**
 * A CloseEvent for the suites that drive a socket's `onclose` by hand.
 *
 * Node has no CloseEvent global, and the client never reads the event, so this builds the same
 * shape from a plain Event plus the three CloseEvent fields. No assertion needed: the result is
 * structurally a CloseEvent.
 *
 * Not named `*.test.ts`, so vitest's default include does not collect it as a suite.
 */
export function closeEvent(code = 1006, reason = ""): CloseEvent {
  return Object.assign(new Event("close"), { code, reason, wasClean: false })
}
