import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  validateArtifactFormat,
  type Component,
  type PlatformId,
} from "../src/binary-cache.js"

function writeMagic(name: string, bytes: number[]): string {
  const dir = mkdtempSync(join(tmpdir(), "supatype-artifact-"))
  const path = join(dir, name)
  writeFileSync(path, Buffer.from(bytes))
  return path
}

function expectValid(component: Component, path: string, platform: PlatformId): void {
  expect(() => validateArtifactFormat(component, path, platform)).not.toThrow()
}

function expectInvalid(component: Component, path: string, platform: PlatformId): void {
  expect(() => validateArtifactFormat(component, path, platform)).toThrow()
}

describe("validateArtifactFormat", () => {
  const paths: string[] = []

  afterEach(() => {
    for (const p of paths) {
      try {
        rmSync(join(p, ".."), { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
    paths.length = 0
  })

  it("accepts ELF for engine/server/deno on linux", () => {
    const linux: PlatformId = { os: "linux", arch: "amd64" }
    for (const component of ["engine", "server", "deno"] as const) {
      const p = writeMagic(component, [0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0])
      paths.push(p)
      expectValid(component, p, linux)
    }
  })

  it("accepts Mach-O for engine on darwin", () => {
    const p = writeMagic("engine", [0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0])
    paths.push(p)
    expectValid("engine", p, { os: "darwin", arch: "arm64" })
  })

  it("accepts PE for deno on windows", () => {
    const p = writeMagic("deno.exe", [0x4d, 0x5a, 0x90, 0x00, 0, 0, 0, 0])
    paths.push(p)
    expectValid("deno", p, { os: "windows", arch: "amd64" })
  })

  it("rejects Go c-archive for server on linux", () => {
    const p = writeMagic("server", [0x21, 0x3c, 0x61, 0x72, 0, 0, 0, 0])
    paths.push(p)
    expectInvalid("server", p, { os: "linux", arch: "amd64" })
  })

  it("accepts gzip for postgres on linux", () => {
    const p = writeMagic("pg.tar.gz", [0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0])
    paths.push(p)
    expectValid("postgres", p, { os: "linux", arch: "amd64" })
  })

  it("accepts zip for postgres on windows", () => {
    const p = writeMagic("pg.zip", [0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])
    paths.push(p)
    expectValid("postgres", p, { os: "windows", arch: "amd64" })
  })

  it("rejects gzip postgres artifact on windows", () => {
    const p = writeMagic("pg.tar.gz", [0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0])
    paths.push(p)
    expectInvalid("postgres", p, { os: "windows", arch: "amd64" })
  })
})
