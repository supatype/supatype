import { describe, it, expect, vi } from "vitest"
import { existsSync, realpathSync } from "node:fs"
import { cliModuleUrl, evalTempFileName, evalTsSnippet, runTsFile } from "../src/tsx-runner.js"
import { uniqueFileToken } from "../src/unique-file-token.js"
import { writeFileSync, unlinkSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

const CLI_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src")

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

    // The snippet file sits in a shared temp directory while it runs, and can carry a project's
    // config or connection string.
    it.skipIf(process.platform === "win32")("writes the snippet readable by this user only", () => {
      const result = evalTsSnippet(
        `import { statSync } from "node:fs"\n` +
          `process.stdout.write((statSync(new URL(import.meta.url)).mode & 0o777).toString(8))`,
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("600")
    })

    // A5-N4: a global install the user cannot write to failed every `diff` with EACCES, because the
    // snippet was written beside the CLI's own source.
    it("writes the snippet in the user's temp directory, not beside the CLI's source", () => {
      const result = evalTsSnippet(
        `import { fileURLToPath } from "node:url"\nprocess.stdout.write(fileURLToPath(import.meta.url))`,
      )
      expect(result.exitCode).toBe(0)
      const where = dirname(result.stdout)
      // The module URL carries the real path: on macOS tmpdir() is /var/..., which links to
      // /private/var/..., so the comparison is made between real paths.
      expect(where.startsWith(realpathSync(tmpdir()))).toBe(true)
      expect(where).not.toBe(realpathSync(CLI_SRC))
      // Removed with the snippet.
      expect(existsSync(where)).toBe(false)
    })

    it("lets a snippet import the CLI's own modules from the temp directory", () => {
      const result = evalTsSnippet(
        `import { evalTempFileName } from ${JSON.stringify(cliModuleUrl("tsx-runner.js"))}\n` +
          `process.stdout.write(evalTempFileName().slice(0, 14))`,
      )
      expect(result.stderr).toBe("")
      expect(result.stdout).toBe("supatype-eval-")
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
