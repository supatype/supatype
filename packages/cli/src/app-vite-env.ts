import { existsSync } from "node:fs"
import { join } from "node:path"
import { writeFrontendEnv } from "./frontend-env.js"
import { projectRootFromConfig, type SupatypeProjectConfig } from "./project-config.js"

/**
 * Write the app dev server's Supatype settings (P2 DX): the API address and the anon key, for a
 * development build only (frontend-env.ts). They were in `.env.local`, which a production Vite build
 * reads, so the local address and key shipped in the bundle; those copies are taken out.
 */
export function writeAppViteEnv(
  cwd: string,
  config: SupatypeProjectConfig,
  apiUrl: string,
  anonKey: string,
): void {
  const appDir = projectRootFromConfig(config, cwd)
  if (!existsSync(join(appDir, "package.json"))) return
  writeFrontendEnv(appDir, { apiUrl, anonKey }, { local: true })
}
