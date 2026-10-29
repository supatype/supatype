/**
 * The file backend: object bytes in a directory on local disk, for native `supatype dev` and a
 * single box with no S3. Bucket and object metadata stay in Postgres; this holds bytes and the
 * content type they were stored with, under names any filesystem keeps apart.
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { DiskStore } from "../src/disk-store.js"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function store(): { root: string; disk: DiskStore } {
  const root = mkdtempSync(join(tmpdir(), "storage-disk-"))
  dirs.push(root)
  return { root, disk: new DiskStore(root) }
}

/** Every file under `dir`, relative, `/`-separated. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1).replace(/\\/g, "/"))
}

describe("the file backend", () => {
  it("gives back the bytes and content type it was given", async () => {
    const { disk } = store()
    await disk.ensureBucket("avatars")
    await disk.putObject("avatars", "me.png/v1", Buffer.from("png bytes"), "image/png")
    const got = await disk.getObject("avatars", "me.png/v1")
    expect(got.body.toString()).toBe("png bytes")
    expect(got.contentType).toBe("image/png")
    expect(got.contentLength).toBe(9)
  })

  it("answers a missing object as S3 does, so the route answers 404", async () => {
    const { disk } = store()
    await expect(disk.getObject("avatars", "nobody")).rejects.toMatchObject({ name: "NoSuchKey" })
  })

  it("keeps apart names that differ only in case, as a case-insensitive filesystem would not", async () => {
    const { disk } = store()
    await disk.putObject("b", "Photo.jpg", Buffer.from("upper"), "image/jpeg")
    await disk.putObject("b", "photo.jpg", Buffer.from("lower"), "image/jpeg")
    expect((await disk.getObject("b", "Photo.jpg")).body.toString()).toBe("upper")
    expect((await disk.getObject("b", "photo.jpg")).body.toString()).toBe("lower")
  })

  it("keeps an object and a folder of the same name apart", async () => {
    const { disk } = store()
    await disk.putObject("b", "docs", Buffer.from("a file"), "text/plain")
    await disk.putObject("b", "docs/readme.md", Buffer.from("inside"), "text/markdown")
    expect((await disk.getObject("b", "docs")).body.toString()).toBe("a file")
    expect((await disk.getObject("b", "docs/readme.md")).body.toString()).toBe("inside")
  })

  it("never writes outside its root, whatever the name", async () => {
    const { root, disk } = store()
    for (const name of ["../escape", "..", "a/../../b", "CON", "x:y*z?.txt", "trailing. ", "%2e%2e"]) {
      await disk.putObject("b", name, Buffer.from(name), "text/plain")
      expect((await disk.getObject("b", name)).body.toString()).toBe(name)
    }
    expect(readdirSync(join(root, ".."))).not.toContain("escape")
    expect(filesUnder(root).every((path) => path.startsWith("b"))).toBe(true)
  })

  it("stores a name too long for one path segment", async () => {
    const { disk } = store()
    const long = "x".repeat(400)
    await disk.putObject("b", long, Buffer.from("long"), "text/plain")
    expect((await disk.getObject("b", long)).body.toString()).toBe("long")
  })

  it("deletes the objects it is given, and a missing one is not an error", async () => {
    const { disk } = store()
    await disk.putObject("b", "a", Buffer.from("a"), "text/plain")
    await disk.putObject("b", "c", Buffer.from("c"), "text/plain")
    await disk.deleteObjects("b", ["a", "never-stored"])
    await expect(disk.getObject("b", "a")).rejects.toMatchObject({ name: "NoSuchKey" })
    expect((await disk.getObject("b", "c")).body.toString()).toBe("c")
  })

  it("deletes a bucket with everything in it", async () => {
    const { root, disk } = store()
    await disk.ensureBucket("gone")
    await disk.putObject("gone", "a", Buffer.from("a"), "text/plain")
    await disk.deleteBucket("gone")
    expect(filesUnder(root)).toEqual([])
  })
})
