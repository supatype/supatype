import { describe, it, expect, vi } from "vitest"
import { existsSync } from "node:fs"
import { evalTempFileName, evalTsSnippet, runTsFile } from "../src/tsx-runner.js"
import { uniqueFileToken } from "../src/unique-file-token.js"
import { writeFileSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

describe("tsx-runner", () => {
  describe("evalTsSnippet()", () => {
    it("evaluates a simple expression and returns stdout", () => {
      const result = evalTsSnippet(
        `process.stdout.write("hello from tsx")`,
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("hello from tsx")
    })

    it("evaluates TypeScript syntax (type annotations)", () => {
      const result = evalTsSnippet(
        `const x: number = 42\nprocess.stdout.write(String(x))`,
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("42")
    })

    it("can serialize a JSON object to stdout", () => {
      const result = evalTsSnippet(
        `const obj = { a: 1, b: "two" }\nprocess.stdout.write(JSON.stringify(obj))`,
      )
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({ a: 1, b: "two" })
    })

    it("returns non-zero exit code on syntax error", () => {
      const result = evalTsSnippet(`const x: = broken syntax !!!`)
      expect(result.exitCode).not.toBe(0)
    })

    it("returns non-zero exit code on runtime error", () => {
      const result = evalTsSnippet(`throw new Error("intentional")`)
      expect(result.exitCode).not.toBe(0)
    })

    // The snippet file sits beside the CLI's source while it runs, and can carry a project's
    // config or connection string.
    it.skipIf(process.platform === "win32")("writes the snippet readable by this user only", () => {
      const result = evalTsSnippet(
        `import { statSync } from "node:fs"\n` +
          `process.stdout.write((statSync(new URL(import.meta.url)).mode & 0o777).toString(8))`,
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("600")
    })

    it("captures stderr separately from stdout", () => {
      const result = evalTsSnippet(
        `process.stderr.write("err")\nprocess.stdout.write("out")`,
      )
      expect(result.stdout).toBe("out")
      expect(result.stderr).toContain("err")
    })
  })

  describe("runTsFile()", () => {
    it("runs a .ts file and returns its stdout", () => {
      const tmp = join(tmpdir(), `dt-tsx-test-${Date.now()}.ts`)
      writeFileSync(tmp, `const n: number = 7\nprocess.stdout.write(String(n))`)
      try {
        const result = runTsFile(tmp)
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe("7")
      } finally {
        unlinkSync(tmp)
      }
    })
  })
})

describe("evalTempFileName()", () => {
  // Every CLI process writes its snippet into the same directory. Named by `Date.now()` alone, two
  // processes in one millisecond wrote one file, and each ran whichever snippet landed last: a
  // test loaded another test's config, whose directory had just been removed, and two CLI commands
  // started together could load each other's project config.
  it("never repeats, even within one millisecond", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_791_183_700_152)
    try {
      expect(evalTempFileName()).not.toBe(evalTempFileName())
    } finally {
      now.mockRestore()
    }
  })
})

describe("uniqueFileToken()", () => {
  // The engine's request files and the config fallback share this helper, and the temp directory.
  it("never repeats, even within one millisecond", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_791_183_700_152)
    try {
      expect(uniqueFileToken()).not.toBe(uniqueFileToken())
    } finally {
      now.mockRestore()
    }
  })
})
