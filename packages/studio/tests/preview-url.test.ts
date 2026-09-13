import { describe, expect, it } from "vitest"
import { previewUrlFor } from "../src/lib/preview-url.js"
import { appOrigin, membershipBase } from "../src/lib/membership-url.js"

// Where a record renders, given what the project said and what the deployment already knows.
//
// The origin used to be required of every project. It is a deployment fact in two of the three app
// modes: `static` and `proxy` both serve the project's app at `/` on the same origin as the API, so
// asking for it in config was asking somebody to retype what Studio was handed, and to keep it in
// step by hand when the deployment moved.

const post = { slug: "hello-world", id: "1" }

describe("resolving a preview address", () => {
  it("fills fields from the record in hand, not from the record as loaded", () => {
    // A slug edited in the form previews at the address it now implies. Otherwise the link points
    // at where the post used to be, which 404s for the person you sent it to.
    expect(previewUrlFor({ urlPattern: "/blog/{slug}" }, post, "https://example.com")).toBe(
      "https://example.com/blog/hello-world",
    )
  })

  it("escapes what it substitutes", () => {
    expect(previewUrlFor({ urlPattern: "/blog/{slug}" }, { slug: "a b/c?d" }, "https://x")).toBe(
      "https://x/blog/a%20b%2Fc%3Fd",
    )
  })

  it("takes a path against the origin the deployment serves the app from", () => {
    expect(previewUrlFor({ urlPattern: "/preview/{slug}" }, post, "http://localhost:18473")).toBe(
      "http://localhost:18473/preview/hello-world",
    )
  })

  it("leaves an absolute URL exactly as given", () => {
    // What `app.mode: "none"` needs: the app is somewhere else and no deployment fact can say
    // where, so the origin Studio knows must not be prepended to it.
    expect(
      previewUrlFor({ urlPattern: "https://blog.example.com/p/{slug}" }, post, "http://localhost"),
    ).toBe("https://blog.example.com/p/hello-world")
  })

  it("leaves a protocol-relative URL alone too", () => {
    expect(previewUrlFor({ urlPattern: "//cdn.example.com/{slug}" }, post, "http://localhost")).toBe(
      "//cdn.example.com/hello-world",
    )
  })

  it("does not double the slash between origin and path", () => {
    expect(previewUrlFor({ urlPattern: "/p/{slug}" }, post, "https://example.com/")).toBe(
      "https://example.com/p/hello-world",
    )
  })

  it("joins a pattern that forgot its leading slash", () => {
    expect(previewUrlFor({ urlPattern: "p/{slug}" }, post, "https://example.com")).toBe(
      "https://example.com/p/hello-world",
    )
  })

  it("falls back to the bare url when no pattern is stated", () => {
    // The right answer for a single-page preview, where every record renders at one address.
    expect(previewUrlFor({ url: "https://example.com/preview" }, post, "http://localhost")).toBe(
      "https://example.com/preview",
    )
  })

  it("says nothing when the project has said nothing", () => {
    // An empty string is what the share control reads as "not configured", which is what makes it
    // name the setting instead of handing over a credential that opens nowhere.
    expect(previewUrlFor({}, post, "https://example.com")).toBe("")
  })

  it("returns the path unchanged when there is no origin to resolve against", () => {
    // Cloud. Better a visibly relative address than one confidently pointing at the wrong host.
    expect(previewUrlFor({ urlPattern: "/p/{slug}" }, post, undefined)).toBe("/p/hello-world")
  })
})

describe("the origin a deployment serves the app from", () => {
  it("is the API base, for self-host", () => {
    expect(appOrigin("http://localhost:18473/studio/proxy")).toBe("http://localhost:18473")
  })

  it("is unknown on cloud, which hosts the API but not the project's app", () => {
    // Guessing at the cloud origin would produce a link that looks right and opens nothing.
    expect(appOrigin("https://api.supatype.dev/projects/abc/proxy")).toBeUndefined()
  })

  it("still points membership at the right place, since both read the same URL", () => {
    // The two share the proxy-stripping and disagreed once about cloud. Pinned together so a change
    // to one cannot quietly move the other.
    expect(membershipBase("http://localhost:18473/studio/proxy")).toBe(
      "http://localhost:18473/admin",
    )
    expect(membershipBase("https://api.supatype.dev/projects/abc/proxy")).toBe(
      "https://api.supatype.dev/projects/abc",
    )
  })
})
