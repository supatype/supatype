import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const CLI_PACKAGE_JSON = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json")

/** Installed @supatype/cli version from package.json (used by --version and init scaffolding). */
export function cliPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(CLI_PACKAGE_JSON, "utf8")) as { version?: string }
    return pkg.version ?? "0.0.0"
  } catch {
    return "0.0.0"
  }
}
