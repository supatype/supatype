import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { EMBEDDED_CLI_VERSION } from "./cli-version-embedded.js"

const CLI_PACKAGE_JSON = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json")

/** Installed @supatype/cli version (used by --version and init scaffolding). */
export function cliPackageVersion(): string {
  // Set in published builds; the package.json read below only works when one is on disk,
  // which is true for the npm package and false inside the standalone binary.
  if (EMBEDDED_CLI_VERSION !== "") return EMBEDDED_CLI_VERSION
  try {
    const pkg = JSON.parse(readFileSync(CLI_PACKAGE_JSON, "utf8")) as { version?: string }
    return pkg.version ?? "0.0.0"
  } catch {
    return "0.0.0"
  }
}
