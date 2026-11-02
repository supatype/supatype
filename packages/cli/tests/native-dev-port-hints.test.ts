import { describe, expect, it } from "vitest"
import { NATIVE_PORT_HINTS } from "../src/commands/dev.js"

/**
 * What native dev says when one of its ports is taken. The line on moving it read "Move this
 * project's with ...", leaving out what was to be moved.
 */
describe("native dev's port-in-use hints", () => {
  it.each(Object.entries(NATIVE_PORT_HINTS))("say which of this project's ports to move (%s)", (_service, hint) => {
    expect(hint.move).toMatch(/^Move this project's [\w ]+ port with /)
  })
})
