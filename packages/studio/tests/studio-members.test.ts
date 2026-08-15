import { describe, expect, it } from "vitest"
import { membershipBase } from "../src/lib/membership-url.js"

describe("membershipBase", () => {
  // Self-host: the routes sit *beside* /studio/proxy, not inside it. The proxy
  // forwards to the data plane; membership is not data-plane traffic, so posting
  // it through the proxy would look for `/rest/v1/admin/studio-members`.
  it("lifts out of the self-host proxy path", () => {
    expect(membershipBase("http://localhost:18473/studio/proxy")).toBe(
      "http://localhost:18473/admin",
    )
    expect(membershipBase("http://localhost:18473/studio/proxy/")).toBe(
      "http://localhost:18473/admin",
    )
  })

  // Cloud: the control plane already scopes the project in the path, and exposes
  // the routes as siblings of the proxy.
  it("drops the cloud proxy suffix", () => {
    expect(membershipBase("https://api.example.com/projects/abc/proxy")).toBe(
      "https://api.example.com/projects/abc",
    )
  })

  it("appends /admin to a bare API URL", () => {
    expect(membershipBase("http://localhost:18473")).toBe("http://localhost:18473/admin")
    expect(membershipBase("http://localhost:18473/")).toBe("http://localhost:18473/admin")
  })
})
