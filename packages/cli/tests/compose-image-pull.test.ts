import { describe, expect, it } from "vitest"
import { shownPullLine } from "../src/self-host-compose.js"

/**
 * Local test round 4: `supatype update` on a Docker project printed compose's
 * `Error response from daemon: ... not found` three times for an image it then said it kept from
 * this machine. Compose's progress is still shown as the pull runs; its closing daemon errors are
 * not, since each image that failed is pulled again on its own, which says why.
 */
describe("what of compose's pull output is shown", () => {
  it("leaves out the daemon's closing errors", () => {
    expect(
      shownPullLine('Error response from daemon: failed to resolve reference "docker.io/supatype/server:it-r3": not found'),
    ).toBe(false)
  })

  it("shows the progress, its failures included", () => {
    expect(shownPullLine(" Image postgrest/postgrest:v14.18 Pulled ")).toBe(true)
    expect(shownPullLine(' Image supatype/server:it-r3 Error failed to resolve reference "docker.io/supatype/server:it-r3"')).toBe(true)
  })
})
