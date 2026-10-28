import { describe, expect, it } from "vitest"
import { isSafeEntryName, readTarGz } from "../src/tar-reader.js"
import { fixtureTarball, plainTarball } from "./support/tar-fixture.js"

/**
 * The tarball reader marks each entry whose name no consumer could write safely, and reads the rest
 * of the archive. An archive names its own paths, and on Windows `\` is a separator to join() and
 * `C:` a drive, so a name only checked for POSIX `../` could still land outside wherever it is
 * written. One such name does not spoil the archive: the consumer decides whether it is one it uses.
 */

describe("readTarGz()", () => {
  it("reads ordinary names and a pax long path", () => {
    const long = `src/${"deeply-nested-".repeat(8)}component.tsx`
    const tarball = fixtureTarball("supatype-0.7.0", [
      { path: "README.md", content: "# Supatype\n" },
      { path: `examples/blog/${long}`, content: "export {}\n" },
      { path: "examples/blog/..notes", content: "x" },
    ])
    const files = readTarGz(tarball).filter((e) => e.kind === "file")
    expect(files.map((e) => e.path)).toEqual([
      "supatype-0.7.0/README.md",
      `supatype-0.7.0/examples/blog/${long}`,
      "supatype-0.7.0/examples/blog/..notes",
    ])
    expect(files.every((e) => e.safe)).toBe(true)
  })

  it.each([
    ["a parent segment", "supatype-0.7.0/examples/blog/../../escape.txt"],
    ["a parent segment at the start", "../escape.txt"],
    ["backslash parent segments", "supatype-0.7.0/..\\..\\escape.txt"],
    ["a backslash anywhere", "supatype-0.7.0/src\\index.ts"],
    ["a NUL", "supatype-0.7.0/README\0.md"],
    ["a drive letter", "C:/escape.txt"],
    ["a drive-relative start", "C:escape.txt"],
    ["a colon later in the name, an NTFS stream on Windows", "supatype-0.7.0/docs/a:b.md"],
    ["an absolute path", "/etc/escape.txt"],
  ])("marks a name with %s unsafe and reads the rest", (_label, name) => {
    const tarball = plainTarball([
      { path: "supatype-0.7.0/README.md", content: "# Supatype\n" },
      { path: name, content: "x" },
    ])
    expect(readTarGz(tarball).map((e) => [e.path, e.safe])).toEqual([
      ["supatype-0.7.0/README.md", true],
      [name, false],
    ])
  })

  it("marks a parent segment in a long name carried by a pax record", () => {
    const name = `supatype-0.7.0/${"nested/".repeat(15)}../../../../../../../../../../../../../../../../escape.txt`
    expect(name.length).toBeGreaterThan(100)
    expect(readTarGz(plainTarball([{ path: name, content: "x" }])).map((e) => e.safe)).toEqual([false])
  })
})

describe("isSafeEntryName()", () => {
  it("refuses a colon anywhere: a drive opening the name, an NTFS stream after it", () => {
    for (const name of ["a:b.md", "docs/a:b.md", "docs/C:", "ab:c.md"]) expect(isSafeEntryName(name)).toBe(false)
    expect(isSafeEntryName("docs/a-b.md")).toBe(true)
  })
})
