import { describe, expect, it } from "vitest"
import {
  ADMIN_EMAIL_ENV,
  ADMIN_PASSWORD_ENV,
  clearAdminSeedPassword,
  hashPasswordForAuth,
} from "../src/commands/admin.js"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { scaffold, defaultScaffoldOptions } from "../src/commands/init.js"

describe("hashPasswordForAuth", () => {
  it("produces a bcrypt hash", async () => {
    const hash = await hashPasswordForAuth("test-password-123")
    expect(hash.startsWith("$2")).toBe(true)
  })
})

describe("clearAdminSeedPassword", () => {
  it("removes SUPATYPE_ADMIN_PASSWORD from .env", () => {
    const dir = join(tmpdir(), `supatype-admin-seed-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, ".env"),
      `${ADMIN_EMAIL_ENV}=admin@example.com\n${ADMIN_PASSWORD_ENV}=secret123\nJWT_SECRET=x\n`,
      "utf8",
    )
    try {
      clearAdminSeedPassword(dir)
      const content = readFileSync(join(dir, ".env"), "utf8")
      expect(content).toContain(`${ADMIN_EMAIL_ENV}=admin@example.com`)
      expect(content).not.toContain(ADMIN_PASSWORD_ENV)
      expect(content).toContain("JWT_SECRET=x")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("init admin seed in .env", () => {
  it("writes SUPATYPE_ADMIN_* when scaffold options include credentials", () => {
    const dir = join(tmpdir(), `supatype-init-admin-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    try {
      scaffold(dir, {
        ...defaultScaffoldOptions("seeded-app"),
        adminEmail: "admin@example.com",
        adminPassword: "password123",
      })
      const env = readFileSync(join(dir, ".env"), "utf8")
      expect(env).toContain("SUPATYPE_ADMIN_EMAIL=admin@example.com")
      expect(env).toContain("SUPATYPE_ADMIN_PASSWORD=password123")
      expect(existsSync(join(dir, ".env"))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
