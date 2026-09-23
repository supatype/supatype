import { describe, expect, it } from "vitest"
import {
  modelsWithUnresolvablePreview,
  unresolvablePreviewMessage,
} from "../src/preview-config-check.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"

// A preview address may be a path, because with `app.mode` of `static` or `proxy` this deployment
// serves the project's app at `/` on the same origin as the API. Studio resolves the path against
// the origin it is loaded from, so the origin never has to be written down or kept in step.
//
// With `app.mode: "none"` nothing is served at `/`. The path then resolves against an origin that
// answers 404, and the failure lands in front of whoever was *sent* the link rather than whoever
// configured it. That is the worst possible place for it, so the push refuses instead.

function project(
  mode: SupatypeProjectConfig["app"]["mode"],
  livePreview?: Record<string, { url?: string; urlPattern?: string }>,
): SupatypeProjectConfig {
  return {
    project: { name: "acme" },
    database: { provider: "docker" },
    server: { mode: "dev" },
    app: { mode },
    versions: { engine: "0", server: "0", postgres: "0", deno: "0" },
    ...(livePreview !== undefined && { admin: { livePreview } }),
  } as SupatypeProjectConfig
}

describe("preview addresses that could never open", () => {
  it("refuses a path when nothing is served at /", () => {
    expect(
      modelsWithUnresolvablePreview(project("none", { Post: { urlPattern: "/preview/{slug}" } })),
    ).toEqual(["Post"])
  })

  it("allows a path when this deployment serves the app", () => {
    for (const mode of ["static", "proxy"] as const) {
      expect(
        modelsWithUnresolvablePreview(project(mode, { Post: { urlPattern: "/preview/{slug}" } })),
      ).toEqual([])
    }
  })

  it("allows an absolute URL in any mode, since it carries its own origin", () => {
    expect(
      modelsWithUnresolvablePreview(
        project("none", { Post: { urlPattern: "https://example.com/p/{slug}" } }),
      ),
    ).toEqual([])
    expect(
      modelsWithUnresolvablePreview(project("none", { Post: { url: "https://example.com/p" } })),
    ).toEqual([])
  })

  it("allows a protocol-relative URL, which already names a host", () => {
    expect(
      modelsWithUnresolvablePreview(project("none", { Post: { urlPattern: "//cdn.example/{s}" } })),
    ).toEqual([])
  })

  it("says nothing about a model that configured no preview at all", () => {
    // Not misconfigured, just not configured. Studio asks for the setting where it is needed; a
    // push has no business refusing over a feature the project has not opted into.
    expect(modelsWithUnresolvablePreview(project("none", { Post: {} }))).toEqual([])
    expect(modelsWithUnresolvablePreview(project("none", { Post: { urlPattern: "" } }))).toEqual([])
    expect(modelsWithUnresolvablePreview(project("none"))).toEqual([])
  })

  it("names every model at fault, in one go", () => {
    // An operator fixing these one push at a time is an operator running the push four times.
    const models = modelsWithUnresolvablePreview(
      project("none", {
        Post: { urlPattern: "/p/{slug}" },
        Author: { urlPattern: "/a/{slug}" },
        Page: { urlPattern: "https://ok.example/{slug}" },
      }),
    )
    expect(models).toEqual(["Author", "Post"])
  })

  it("prefers the pattern over the url, which is what Studio does", () => {
    // A project giving both gets the pattern. Checking the url instead would pass a config that
    // then renders from the path and breaks.
    expect(
      modelsWithUnresolvablePreview(
        project("none", { Post: { url: "https://example.com", urlPattern: "/p/{slug}" } }),
      ),
    ).toEqual(["Post"])
  })
})

describe("what the refusal says", () => {
  it("names the models and the mode that make it unresolvable", () => {
    const message = unresolvablePreviewMessage(["Author", "Post"])
    expect(message).toContain("Author, Post")
    expect(message).toContain('app.mode is "none"')
  })

  it("reads correctly for a single model", () => {
    expect(unresolvablePreviewMessage(["Post"])).toContain("that path")
    expect(unresolvablePreviewMessage(["Post", "Author"])).toContain("those paths")
  })
})
