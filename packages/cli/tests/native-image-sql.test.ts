import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { isArrayOf, isNumber, isShape, isString } from "@supatype/shared"
import { PGRST_WATCH_SQL, POSTGRES_SEARCH_PATH_SQL } from "../src/native-roles-sql.js"
import { parseJsonAs } from "./support/json.js"

/**
 * Native dev copies SQL from the supatype/postgres image (PostgREST's schema-cache triggers, the
 * postgres role's search_path). The copies are checked against vendored sources, recorded with
 * their path and sha256 in fixtures/image-sql/sources.json; scripts/check-image-sql.mjs checks the
 * vendored sources against a supatype-postgres checkout, and runs here when SUPATYPE_POSTGRES_REPO
 * names one.
 */
const FIXTURES = join(import.meta.dirname, "fixtures", "image-sql")
const sources = parseJsonAs(
  readFileSync(join(FIXTURES, "sources.json"), "utf8"),
  isShape({
    files: isArrayOf(isShape({ vendored: isString, source: isString, sha256: isString })),
    lines: isArrayOf(isShape({ source: isString, line: isNumber, text: isString })),
  }),
)
const lf = (text: string): string => text.replace(/\r\n/g, "\n")

/** The statements of a SQL text: no comment-only lines, no blank lines, no surrounding space. */
function statementLines(sql: string): string[] {
  return lf(sql)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("--"))
}

/** The image migration's `migrate:up` statements, less the drops of a trigger it replaced. */
function migrationStatements(file: string): string[] {
  const up = lf(readFileSync(join(FIXTURES, file), "utf8")).split("-- migrate:down")[0] ?? ""
  return statementLines(up).filter((line) => !/api_restart/.test(line))
}

describe("native dev's copies of the image SQL", () => {
  it("vendor their sources unchanged", () => {
    for (const file of sources.files) {
      const sha = createHash("sha256").update(lf(readFileSync(join(FIXTURES, file.vendored), "utf8"))).digest("hex")
      expect(sha, file.vendored).toBe(file.sha256)
    }
  })

  it("install PostgREST's schema-cache triggers as the image's migration does", () => {
    const [watch] = sources.files
    expect(statementLines(PGRST_WATCH_SQL)).toEqual(migrationStatements(watch?.vendored ?? ""))
  })

  it("set the postgres role's search_path with the image's own statement", () => {
    for (const copied of sources.lines) expect(POSTGRES_SEARCH_PATH_SQL).toContain(copied.text)
  })

  const repo = process.env["SUPATYPE_POSTGRES_REPO"]
  it.skipIf(repo === undefined)("match a supatype-postgres checkout", () => {
    const script = join(import.meta.dirname, "..", "..", "..", "scripts", "check-image-sql.mjs")
    const result = spawnSync(process.execPath, [script, repo ?? ""], { encoding: "utf8" })
    expect(result.stderr).toBe("")
    expect(result.status).toBe(0)
  })
})
