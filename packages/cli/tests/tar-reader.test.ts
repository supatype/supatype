import { describe, expect, it } from "vitest"
import { readTarGz } from "../src/tar-reader.js"
import { fixtureTarball, plainTarball } from "./support/tar-fixture.js"

/**
 * The tarball reader refuses an archive with an entry name no consumer could write safely. An
 * archive names its own paths, and on Windows `\` is a separator to join() and `C:` a drive, so a
 * name only checked for POSIX `../` could still land outside wherever it is written.
 */

describe("readTarGz()", () => {
  it("reads ordinary names, a pax long path included", () => {
    const long = `src/${"deeply-nested-".repeat(8)}component.tsx`
    const tarball = fixtureTarball("supatype-0.7.0", [
      { path: "README.md", content: "# Supatype\n" },
      { path: `examples/blog/${long}`, content: "export {}\n" },
      { path: "examples/blog/..notes", content: "x" },
    ])
    const files = readTarGz(tarball).filter((e) => e.kind === "file").map((e) => e.path)
    expect(files).toEqual([
      "supatype-0.7.0/README.md",
      `supatype-0.7.0/examples/blog/${long}`,
      "supatype-0.7.0/examples/blog/..notes",
    ])
  })

  it.each([
    ["a parent segment", "supatype-0.7.0/examples/blog/../../escape.txt"],
    ["a parent segment at the start", "../escape.txt"],
    ["backslash parent segments", "supatype-0.7.0/..\\..\\escape.txt"],
    ["a backslash anywhere", "supatype-0.7.0/src\\index.ts"],
    ["a NUL", "supatype-0.7.0/README\0.md"],
    ["a drive letter", "C:/escape.txt"],
    ["a drive letter in a later segment", "supatype-0.7.0/src/C:escape.txt"],
    ["an absolute path", "/etc/escape.txt"],
  ])("refuses a name with %s", (_label, name) => {
    const tarball = plainTarball([
      { path: "supatype-0.7.0/README.md", content: "# Supatype\n" },
      { path: name, content: "x" },
    ])
    expect(() => readTarGz(tarball)).toThrow(/unsafe entry name/)
  })

  it("refuses a parent segment in a long name carried by a pax record", () => {
    const name = `supatype-0.7.0/${"nested/".repeat(15)}../../../../../../../../../../../../../../../../escape.txt`
    expect(name.length).toBeGreaterThan(100)
    expect(() => readTarGz(plainTarball([{ path: name, content: "x" }]))).toThrow(/unsafe entry name/)
  })
})
