import { describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { composeProjectName } from "../src/self-host-compose.js"

/**
 * The e2e scripts clear a stack by its compose project name before and after a run, so they have to
 * name it the way `dev` does. zero-to-running built `supatype-$PROJECT_NAME` by hand, which for a
 * name with upper case or spaces is a project `dev` never creates, and the clear removed nothing.
 */

const LIB = fileURLToPath(
  new URL("../../../tests/integration/scripts/lib/compose-reset.sh", import.meta.url),
)

// Windows may resolve `bash` to WSL, which cannot read a Windows path; the scripts run on Linux CI.
const hasBash = process.platform !== "win32" && spawnSync("bash", ["--version"]).status === 0

describe.skipIf(!hasBash)("compose_project_name in the e2e scripts", () => {
  it.each([
    "ztr-smoke",
    "My App",
    "Ztr_Smoke 2",
    "--edge--",
    "a.b/c",
    "!!!",
    "",
  ])("names %j as composeProjectName does", (name) => {
    const result = spawnSync(
      "bash",
      ["-c", 'source "$1" && compose_project_name "$2"', "test", LIB, name],
      { encoding: "utf8" },
    )
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe(composeProjectName(name))
  })
})
