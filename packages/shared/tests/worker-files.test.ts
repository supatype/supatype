import { describe, expect, it } from "vitest"
import { workerLoadsFile } from "../src/index.js"

describe("workerLoadsFile()", () => {
  it("is true for every source the worker imports", () => {
    for (const path of ["index.ts", "a.tsx", "a.mts", "lib/a.js", "a.jsx", "util.mjs", "data/greeting.json", `lib\\b.ts`]) {
      expect(workerLoadsFile(path), path).toBe(true)
    }
  })

  it("is false for a dotfile, a file in a dot directory, and anything that is not a source", () => {
    for (const path of [".env.local", ".hidden.ts", ".git/x.ts", `lib\\.cache\\y.js`, "README.md", "a.ts.swp", "notes.txt"]) {
      expect(workerLoadsFile(path), path).toBe(false)
    }
  })
})
