import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, test } from "node:test"
import { fileUnder, writeChanged, writeRoot } from "../src/deploy-files.js"

/**
 * PR #293 CI, Windows: a GitHub runner's temp directory is `C:\Users\RUNNER~1\...`, an 8.3 short
 * name. The real path of a deploy's root was taken with realpathSync, which leaves a short name as it
 * is, and compared with fs.promises.realpath of the file's directory, which expands it; the two never
 * matched, so every write was refused as "outside its directory" and the env and hooks routes failed
 * there, though they passed on a machine whose paths have no short names.
 */
const dirs: string[] = []
after(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The 8.3 short form of `path`, or undefined where there is none (not Windows, or names not generated). */
function shortPathOf(path: string): string | undefined {
  if (process.platform !== "win32") return undefined
  const short = spawnSync("cmd", ["/d", "/c", `for %I in ("${path}") do @echo %~sI`], { encoding: "utf8", windowsVerbatimArguments: true }).stdout.trim()
  return short !== "" && short.toLowerCase() !== path.toLowerCase() ? short : undefined
}

describe("a deploy's root named by its 8.3 short path", () => {
  test("is written to, as the same directory its long name names", async (t) => {
    const base = mkdtempSync(join(tmpdir(), "sh-deploy-files-"))
    dirs.push(base)
    const long = join(base, "a-directory-name-longer-than-eight")
    mkdirSync(long)
    const short = shortPathOf(long)
    if (short === undefined) {
      t.skip("this machine gives the directory no 8.3 short name")
      return
    }
    const root = writeRoot(short, "Hooks", { mayBeLink: true })
    await writeChanged([fileUnder(root, "tag-note/index.ts", "export default 1\n")])
    assert.equal(readFileSync(join(long, "tag-note", "index.ts"), "utf8"), "export default 1\n")
  })
})
