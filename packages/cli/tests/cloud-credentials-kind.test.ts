import { isJsonObject } from "@supatype/shared"
import { readFileSync, writeFileSync } from "node:fs"
import { beforeEach, describe, expect, it } from "vitest"
import { DEFAULT_API_URL, trimApiUrl } from "../src/api-url.js"
import {
  clearCloudCredentials,
  credentialKind,
  credentialsPath,
  loadCloudCredentials,
  persistCloudSession,
} from "../src/cloud-credentials.js"
import { tempProject } from "./support/command-run.js"
import { parseJsonAs } from "./support/json.js"

const PAT = `spt_${"b2".repeat(20)}`

beforeEach(() => clearCloudCredentials())

describe("trimApiUrl", () => {
  it("drops every slash that ends the URL and nothing else", () => {
    expect(trimApiUrl("https://api.example.test/")).toBe("https://api.example.test")
    expect(trimApiUrl("https://api.example.test//")).toBe("https://api.example.test")
    expect(trimApiUrl("https://api.example.test/v1")).toBe("https://api.example.test/v1")
    expect(DEFAULT_API_URL).toBe("https://api.supatype.com")
  })
})

describe("the kind of a stored credential", () => {
  it("is written when the credential is saved", () => {
    const project = tempProject("cred-kind")
    persistCloudSession(project.dir, { apiUrl: "http://cp.test/", accessToken: PAT, kind: "pat" })
    expect(JSON.parse(readFileSync(credentialsPath(), "utf8"))).toMatchObject({ kind: "pat", apiUrl: "http://cp.test" })
    persistCloudSession(project.dir, { apiUrl: "http://cp.test", accessToken: "jwt", kind: "session", refreshToken: "r" })
    expect(loadCloudCredentials()).toMatchObject({ kind: "session", refreshToken: "r" })
    project.remove()
  })

  it("is read as a session for an old file, unless its token has the access token shape", () => {
    const project = tempProject("cred-kind-old")
    persistCloudSession(project.dir, { apiUrl: "http://cp.test", accessToken: "jwt", kind: "session" })
    const stored = parseJsonAs(readFileSync(credentialsPath(), "utf8"), isJsonObject)
    delete stored["kind"]
    writeFileSync(credentialsPath(), JSON.stringify(stored))
    const old = loadCloudCredentials()
    expect(old).not.toBeNull()
    expect(credentialKind(old!)).toBe("session")
    expect(credentialKind({ ...old!, accessToken: PAT })).toBe("pat")
    project.remove()
  })

  it("keeps the email a refresh does not mention", () => {
    const project = tempProject("cred-kind-email")
    persistCloudSession(project.dir, { apiUrl: "http://cp.test", accessToken: "jwt", kind: "session", email: "a@b.test" })
    persistCloudSession(project.dir, { apiUrl: "http://cp.test", accessToken: "jwt2", kind: "session" })
    expect(loadCloudCredentials()?.email).toBe("a@b.test")
    project.remove()
  })
})
