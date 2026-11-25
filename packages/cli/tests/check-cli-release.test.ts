import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { embeddedKeyOf, publishedPackages, releaseProblems, scaffoldedPackages, type ReleaseFacts as Facts } from "../../../scripts/check-cli-release.mjs"

/** A release that is fit in every respect; each test breaks one thing. */
function fit(over: Partial<Facts> = {}): Facts {
  return {
    version: "0.8.0",
    scaffolded: ["cli", "client", "types"],
    publishing: ["types", "client", "cli"],
    isPublished: async () => false,
    embeddedPublicKey: "RWQabc",
    clientPrepareBin: "./bin/supatype-prepare.js",
    prepareCommand: "supatype-prepare",
    cdnHas: async () => true,
    ...over,
  }
}

const repo = (...parts: string[]): string => readFileSync(join(import.meta.dirname, "..", "..", "..", ...parts), "utf8")

describe("releaseProblems", () => {
  it("passes a release whose packages, key and CDN program are all there", async () => {
    expect(await releaseProblems(fit())).toEqual([])
  })

  it("refuses when init scaffolds a package this run does not publish and npm lacks", async () => {
    const problems = await releaseProblems(fit({ publishing: ["types", "cli"] }))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("@supatype/client ^0.8.0")
  })

  it("accepts a package npm already has at that version, though this run does not publish it", async () => {
    const isPublished = async (name: string, version: string): Promise<boolean> => name === "client" && version === "0.8.0"
    expect(await releaseProblems(fit({ publishing: ["types", "cli"], isPublished }))).toEqual([])
  })

  it("refuses a client without the supatype-prepare bin", async () => {
    const problems = await releaseProblems(fit({ clientPrepareBin: undefined }))
    expect(problems.join("\n")).toContain("supatype-prepare")
  })

  it("refuses a build with no embedded public key", async () => {
    const problems = await releaseProblems(fit({ embeddedPublicKey: "  " }))
    expect(problems.join("\n")).toMatch(/public key/)
  })

  it("refuses when the CDN lacks the program's checksums or signature", async () => {
    const problems = await releaseProblems(fit({ cdnHas: async (path) => !path.endsWith(".minisig") }))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("/cli/v0.8.0/checksums.sha256.minisig")
  })

  it("reports every problem at once", async () => {
    const problems = await releaseProblems(fit({ publishing: [], embeddedPublicKey: "", cdnHas: async () => false }))
    expect(problems.length).toBeGreaterThanOrEqual(5)
  })
})

describe("what the check reads from the tree", () => {
  it("finds the packages init scaffolds, and ignores ones only named in comments", () => {
    expect(scaffoldedPackages(repo("packages", "cli", "src", "init-package-json.ts"))).toEqual(["cli", "client", "react", "types"])
  })

  it("finds the packages the npm job publishes, ending with cli", () => {
    const names = publishedPackages(repo(".github", "workflows", "release.yml"))
    expect(names).toContain("client")
    expect(names.at(-1)).toBe("cli")
  })

  it("reads an empty and a filled embedded key", () => {
    expect(embeddedKeyOf(repo("packages", "cli", "src", "release-public-key.ts"))).toBe("")
    expect(embeddedKeyOf('export const EMBEDDED_RELEASE_PUBLIC_KEY = "RWQxyz"')).toBe("RWQxyz")
  })

  it("every package init scaffolds is one the npm job publishes", () => {
    const published = publishedPackages(repo(".github", "workflows", "release.yml"))
    for (const name of scaffoldedPackages(repo("packages", "cli", "src", "init-package-json.ts"))) {
      expect(published).toContain(name)
    }
  })
})
