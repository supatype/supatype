import { describe, expect, it } from "vitest"
import { restartRefusal } from "../src/stack-running.js"

/**
 * `self-host compose restart <service>` recreates one service with `up --no-deps`. Run where the
 * stack was not running (a folder whose project name matched a stack already taken down), it
 * created that one container alone, plus a database volume and networks for a stack that did not
 * exist, holding this folder's mount (0.9.3 end-to-end test). A stack with no containers is now
 * refused, naming `up`.
 */
describe("restart on a stack that is not running", () => {
  it("is refused, naming the stack and how to start it", () => {
    const refusal = restartRefusal("functions-worker", "supatype-app", () => "")
    expect(refusal).toContain("supatype-app")
    expect(refusal).toContain("supatype self-host compose up")
  })

  it("goes ahead when the stack has containers", () => {
    expect(restartRefusal("functions-worker", "supatype-app", () => "3f2a\n9c1b\n")).toBeNull()
  })

  it("goes ahead when Docker cannot be asked, as the compose call will say why", () => {
    expect(restartRefusal("functions-worker", "supatype-app", () => null)).toBeNull()
  })
})
