import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DEV_FRONTEND_ENV_FILE, isLocalUrl, writeFrontendEnv } from "../src/frontend-env.js"
import { readEnvFile } from "../src/env-file.js"

/**
 * Issue 23: the CLI wrote `VITE_SUPATYPE_URL=http://localhost:<port>` to `.env` (and native dev to
 * `.env.local`). Vite reads both in a production build, so the local address shipped in the bundle,
 * and with it the local stack's anon key. A local stack's values go to `.env.development.local`,
 * which Vite, Next.js and Expo read in development only; a real deployment's go to `.env`, which a
 * production build reads. Copies of local values the CLI left in `.env` or `.env.local` are taken
 * out, saying so; a value pointing anywhere else is never touched.
 */
const URL = "http://localhost:18478"
const ANON = "dev.anon.key"
const URL_NAMES = ["VITE_SUPATYPE_URL", "PUBLIC_SUPATYPE_URL", "NEXT_PUBLIC_SUPATYPE_URL", "EXPO_PUBLIC_SUPATYPE_URL"]
const ANON_NAMES = ["VITE_SUPATYPE_ANON_KEY", "PUBLIC_SUPATYPE_ANON_KEY", "NEXT_PUBLIC_SUPATYPE_ANON_KEY", "EXPO_PUBLIC_SUPATYPE_ANON_KEY"]
let dir = ""
const lines: string[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-frontend-env-"))
  lines.length = 0
  vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => void lines.push(parts.map(String).join(" ")))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

const devFile = () => readEnvFile(dir, DEV_FRONTEND_ENV_FILE)

describe("isLocalUrl", () => {
  it.each(["http://localhost:18478", "http://127.0.0.1:5173", "http://localhost"])("%s is local", (url) => {
    expect(isLocalUrl(url)).toBe(true)
  })
  it.each(["https://api.example.com", "http://10.0.0.5:8000", "not a url"])("%s is not", (url) => {
    expect(isLocalUrl(url)).toBe(false)
  })
})

describe("a local stack's front-end values", () => {
  it("go to .env.development.local under every framework's names, Expo's included", () => {
    writeFrontendEnv(dir, { apiUrl: URL, anonKey: ANON })
    expect(DEV_FRONTEND_ENV_FILE).toBe(".env.development.local")
    for (const name of URL_NAMES) expect(devFile()[name]).toBe(URL)
    for (const name of ANON_NAMES) expect(devFile()[name]).toBe(ANON)
    expect(existsSync(join(dir, ".env"))).toBe(false)
  })

  it("take the CLI's copies out of .env and .env.local, and say so once", () => {
    writeFileSync(
      join(dir, ".env"),
      `JWT_SECRET=s\nANON_KEY=${ANON}\nVITE_SUPATYPE_URL=${URL}\nPUBLIC_SUPATYPE_URL=http://localhost:18474\nVITE_SUPATYPE_ANON_KEY=${ANON}\n`,
    )
    writeFileSync(join(dir, ".env.local"), "VITE_SUPATYPE_URL=http://127.0.0.1:9999\nOTHER=1\n")
    writeFrontendEnv(dir, { apiUrl: URL, anonKey: ANON })
    expect(readEnvFile(dir)).toEqual({ JWT_SECRET: "s", ANON_KEY: ANON })
    expect(readEnvFile(dir, ".env.local")).toEqual({ OTHER: "1" })
    expect(lines.filter((line) => line.includes(DEV_FRONTEND_ENV_FILE))).toHaveLength(1)
  })

  it("leave a local URL in .env when no URL is written in its place", () => {
    writeFileSync(join(dir, ".env"), `VITE_SUPATYPE_URL=${URL}\n`)
    writeFrontendEnv(dir, { anonKey: ANON }, { local: true })
    expect(readEnvFile(dir)["VITE_SUPATYPE_URL"]).toBe(URL)
  })

  it("leave a URL or key pointing anywhere else alone", () => {
    writeFileSync(join(dir, ".env"), "VITE_SUPATYPE_URL=https://api.example.com\nVITE_SUPATYPE_ANON_KEY=prod.anon.key\n")
    writeFrontendEnv(dir, { apiUrl: URL, anonKey: ANON })
    expect(readEnvFile(dir)).toEqual({ VITE_SUPATYPE_URL: "https://api.example.com", VITE_SUPATYPE_ANON_KEY: "prod.anon.key" })
    expect(lines).toEqual([])
  })

  it("say nothing when there was nothing to move, and write each name once", () => {
    writeFrontendEnv(dir, { apiUrl: URL, anonKey: ANON })
    writeFrontendEnv(dir, { apiUrl: URL, anonKey: ANON })
    expect(lines).toEqual([])
    expect(readFileSync(join(dir, DEV_FRONTEND_ENV_FILE), "utf8").match(/^VITE_SUPATYPE_URL=/gm)).toHaveLength(1)
  })

  it("keep a value already there unless told to replace it", () => {
    writeFileSync(join(dir, DEV_FRONTEND_ENV_FILE), "VITE_SUPATYPE_URL=http://127.0.0.1:9000\n")
    writeFrontendEnv(dir, { apiUrl: URL }, { replace: false })
    expect(devFile()["VITE_SUPATYPE_URL"]).toBe("http://127.0.0.1:9000")
    writeFrontendEnv(dir, { apiUrl: URL })
    expect(devFile()["VITE_SUPATYPE_URL"]).toBe(URL)
  })
})

describe("a real deployment's front-end values", () => {
  it("go to .env, which a production build reads", () => {
    writeFrontendEnv(dir, { apiUrl: "https://api.example.com", anonKey: "prod.anon.key" })
    expect(readEnvFile(dir)["VITE_SUPATYPE_URL"]).toBe("https://api.example.com")
    expect(readEnvFile(dir)["NEXT_PUBLIC_SUPATYPE_ANON_KEY"]).toBe("prod.anon.key")
    expect(existsSync(join(dir, DEV_FRONTEND_ENV_FILE))).toBe(false)
  })
})
