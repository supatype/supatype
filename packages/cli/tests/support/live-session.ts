import { readEnvFile } from "../../src/env-file.js"
import { FRONTEND_URL_KEYS } from "../../src/frontend-env.js"

/** `key` as compose reads it in `cwd`: the environment it inherits ahead of the project's `.env`. */
export function interpolated(key: string, cwd: string): string | undefined {
  const fromShell = process.env[key]?.trim() ?? ""
  return fromShell !== "" ? fromShell : readEnvFile(cwd)[key]
}

/** Every value a dev session holds for its run only, and so may record for later commands. */
export const SESSION_KEYS: readonly string[] = [
  "SUPATYPE_KONG_PORT",
  "SUPATYPE_DEV_DB_PORT",
  "API_EXTERNAL_URL",
  "SITE_URL",
  "DATABASE_URL",
  ...FRONTEND_URL_KEYS,
]

const SESSION_URL = "http://localhost:18780"

/** What a dev session given 18780 and 54780 by its shell holds for its run and records. */
export const SESSION_RUN_ENV: Readonly<Record<string, string>> = {
  SUPATYPE_KONG_PORT: "18780",
  SUPATYPE_DEV_DB_PORT: "54780",
  API_EXTERNAL_URL: SESSION_URL,
  SITE_URL: SESSION_URL,
  DATABASE_URL: "postgresql://postgres:pw@127.0.0.1:54780/acme",
  ...Object.fromEntries(FRONTEND_URL_KEYS.map((key) => [key, SESSION_URL])),
}
