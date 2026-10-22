import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { demoDataHint } from "../src/dev-ready-panel.js"

/**
 * Fresh-user test C28: `supatype dev` printed "Demo data: pnpm seed" in an npm project. The hint
 * names the project's own package manager, and npm's form of running a script.
 */
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-demo-hint-"))
  writeFileSync(join(dir, "seed.ts"), "export default async function seed() {}\n")
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("dev's demo data hint", () => {
  it("is npm run seed in an npm project", () => {
    writeFileSync(join(dir, "package-lock.json"), "{}\n")
    expect(demoDataHint(dir)).toBe("Demo data: npm run seed")
  })

  it("is pnpm seed in a pnpm project", () => {
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9\n")
    expect(demoDataHint(dir)).toBe("Demo data: pnpm seed")
  })

  it("is yarn seed in a yarn project", () => {
    writeFileSync(join(dir, "yarn.lock"), "\n")
    expect(demoDataHint(dir)).toBe("Demo data: yarn seed")
  })

  it("is absent when the project has no seed.ts", () => {
    rmSync(join(dir, "seed.ts"))
    expect(demoDataHint(dir)).toBeUndefined()
  })
})
