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

  it("shows the progress", () => {
    expect(shownPullLine(" Image postgrest/postgrest:v14.18 Pulled ")).toBe(true)
    expect(shownPullLine(" Image supatype/server:it-r3 Pulling ")).toBe(true)
  })

  // Local test round 7, Docker Compose v5.6.1: a kept image showed compose's own per-image error and
  // the "Interrupted" lines of every other image before the CLI's "kept the image" lines. Each image
  // that failed is pulled again on its own, which says why, so neither is shown.
  it("leaves out compose's per-image errors and the pulls it interrupted", () => {
    expect(shownPullLine(' Image supatype/server:it-r3 Error failed to resolve reference "docker.io/supatype/server:it-r3": docker.io/supatype/server:it-r3: not found')).toBe(false)
    expect(shownPullLine(" Image supatype/storage:it-r3 Interrupted ")).toBe(false)
    expect(shownPullLine(" Image chrislusf/seaweedfs:4.46@sha256:08d516132314207d10c8e37cbffc1f32b147d870169688734cc61c6231625b62 Interrupted ")).toBe(false)
  })

  it("still shows a line that only mentions an error", () => {
    expect(shownPullLine(" Image supatype/errorpages:1 Pulled ")).toBe(true)
    expect(shownPullLine("WARN[0000] The \"X\" variable is not set. Error handling defaults to a blank string.")).toBe(true)
  })
})
