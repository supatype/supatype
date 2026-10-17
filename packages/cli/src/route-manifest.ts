import { existsSync, writeFileSync } from "node:fs"
import { readJsonObjectFile } from "./json-file.js"

/** Merge fields into `.supatype/manifest.json` (creates file if missing). */
export function patchRouteManifest(
  manifestPath: string,
  patch: Record<string, unknown>,
): void {
  // Unreadable or not an object, the manifest starts again from the patch.
  const manifest = (existsSync(manifestPath) ? readJsonObjectFile(manifestPath) : undefined) ?? {}
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, ...patch }, null, 2)}\n`, "utf8")
}
