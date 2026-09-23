import { existsSync, readFileSync, writeFileSync } from "node:fs"

/** Merge fields into `.supatype/manifest.json` (creates file if missing). */
export function patchRouteManifest(
  manifestPath: string,
  patch: Record<string, unknown>,
): void {
  let manifest: Record<string, unknown> = {}
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
    } catch {
      manifest = {}
    }
  }
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, ...patch }, null, 2)}\n`, "utf8")
}
