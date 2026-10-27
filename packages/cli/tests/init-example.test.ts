import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { afterEach, describe, expect, it } from "vitest"
import {
  exampleNames,
  exampleTarballUrl,
  initFromExample,
  rewriteWorkspaceDependencies,
  selectExample,
} from "../src/init-example.js"
import { readTarGz } from "../src/tar-reader.js"
import { fixtureTarball } from "./support/tar-fixture.js"

/**
 * `supatype init <dir> --example <name>`: the example folder from the release tag matching the CLI,
 * with its workspace dependencies pinned to that release. No network here: the tarball is a
 * fixture shaped like GitHub's codeload archive.
 */

const LONG = `src/${"deeply-nested-".repeat(8)}component.tsx`
const BLOG_PACKAGE = {
  name: "@supatype/example-blog",
  dependencies: { "@supatype/client": "workspace:*", next: "^15.0.0" },
  devDependencies: { "@supatype/cli": "workspace:*", "@supatype/common": "workspace:^" },
}
const TARBALL = fixtureTarball("supatype-0.7.0", [
  { path: "README.md", content: "# Supatype\n" },
  { path: "examples/README.md", content: "# Examples\n" },
  { path: "examples/blog/README.md", content: "# Blog\n\nRun `supatype dev`.\n" },
  { path: "examples/blog/package.json", content: `${JSON.stringify(BLOG_PACKAGE, null, 2)}\n` },
  { path: `examples/blog/${LONG}`, content: "export {}\n" },
  { path: "examples/blog/apps/web/package.json", content: JSON.stringify({ dependencies: { "@supatype/react": "workspace:*" } }) },
  { path: "examples/realtime/README.md", content: "# Realtime\n" },
  { path: "packages/cli/package.json", content: "{}\n" },
])

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function target(): string {
  const parent = mkdtempSync(join(tmpdir(), "supatype-init-example-"))
  dirs.push(parent)
  return join(parent, "my-blog")
}

const serve = (tarball: Buffer) => (): Promise<Buffer> => Promise.resolve(tarball)

describe("the example tarball", () => {
  it("is the codeload archive of the tag matching the CLI", () => {
    expect(exampleTarballUrl("0.7.0")).toBe("https://codeload.github.com/supatype/supatype/tar.gz/refs/tags/v0.7.0")
  })

  it("reads every file, a pax long path included", () => {
    const paths = readTarGz(TARBALL).filter((e) => e.kind === "file").map((e) => e.path)
    expect(paths).toContain(`supatype-0.7.0/examples/blog/${LONG}`)
    expect(paths).not.toContain("pax_global_header")
  })

  it("lists the example folders, not the files beside them", () => {
    expect(exampleNames(readTarGz(TARBALL))).toEqual(["blog", "realtime"])
  })

  it("refuses something that is not a gzipped tarball", () => {
    expect(() => readTarGz(Buffer.from("<html>Not Found</html>"))).toThrow(/not a gzipped tarball/)
    expect(() => readTarGz(gzipSync(Buffer.from("x".repeat(600))))).toThrow(/not a tarball/)
  })
})

describe("selecting an example", () => {
  it("takes only that example's files, relative to it", () => {
    const files = selectExample(readTarGz(TARBALL), "blog").map((f) => f.path).sort()
    expect(files).toEqual(["README.md", "apps/web/package.json", "package.json", LONG].sort())
  })

  it("refuses an unknown name, listing the valid ones", () => {
    expect(() => selectExample(readTarGz(TARBALL), "blogg")).toThrow(/Unknown example "blogg".*blog, realtime/s)
  })

  it("refuses a path that climbs out of the example", () => {
    const evil = fixtureTarball("supatype-0.7.0", [{ path: "examples/blog/../../escape.txt", content: "x" }])
    expect(() => selectExample(readTarGz(evil), "blog")).toThrow(/outside the example/)
  })
})

describe("rewriting workspace dependencies", () => {
  it("pins every workspace: dependency to the release, leaving the rest", () => {
    const pkg: unknown = JSON.parse(rewriteWorkspaceDependencies(JSON.stringify(BLOG_PACKAGE), "0.7.0"))
    expect(pkg).toEqual({
      name: "@supatype/example-blog",
      dependencies: { "@supatype/client": "^0.7.0", next: "^15.0.0" },
      devDependencies: { "@supatype/cli": "^0.7.0", "@supatype/common": "^0.7.0" },
    })
  })
})

describe("initFromExample()", () => {
  it("writes the example into the directory with its dependencies pinned", async () => {
    const dir = target()
    const fetched: string[] = []
    const download = (url: string): Promise<Buffer> => {
      fetched.push(url)
      return Promise.resolve(TARBALL)
    }
    const result = await initFromExample({ dir, example: "blog", version: "0.7.0", download })
    expect(fetched).toEqual([exampleTarballUrl("0.7.0")])
    expect(readFileSync(join(dir, "README.md"), "utf8")).toContain("# Blog")
    expect(existsSync(join(dir, LONG))).toBe(true)
    const pkg = readFileSync(join(dir, "package.json"), "utf8")
    expect(pkg).not.toContain("workspace:")
    expect(pkg).toContain('"@supatype/client": "^0.7.0"')
    expect(readFileSync(join(dir, "apps/web/package.json"), "utf8")).toContain('"@supatype/react": "^0.7.0"')
    expect(result.hasReadme).toBe(true)
  })

  it("refuses a directory that already has files", async () => {
    const dir = target()
    await initFromExample({ dir, example: "realtime", version: "0.7.0", download: serve(TARBALL) })
    await expect(initFromExample({ dir, example: "blog", version: "0.7.0", download: serve(TARBALL) })).rejects.toThrow(
      /already exists and is not empty/,
    )
  })

  it("refuses an unknown example before writing anything", async () => {
    const dir = target()
    await expect(initFromExample({ dir, example: "nope", version: "0.7.0", download: serve(TARBALL) })).rejects.toThrow(
      /Unknown example "nope"/,
    )
    expect(existsSync(dir)).toBe(false)
  })
})
