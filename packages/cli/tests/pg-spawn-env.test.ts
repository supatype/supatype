import { describe, expect, it } from "vitest"
import { join } from "node:path"
import { pgSpawnEnv } from "../src/postgres-ctl.js"

const PG_BIN = "/cache/postgres/17.2/pg-17.2/bin"
const PG_LIB = join("/cache/postgres/17.2/pg-17.2", "lib")

describe("pgSpawnEnv", () => {
  it("prepends lib dir to DYLD_LIBRARY_PATH on darwin", () => {
    const env = pgSpawnEnv(PG_BIN, "darwin")
    expect(env.DYLD_LIBRARY_PATH).toContain(PG_LIB)
  })

  it("prepends lib dir to LD_LIBRARY_PATH on linux", () => {
    const env = pgSpawnEnv(PG_BIN, "linux")
    expect(env.LD_LIBRARY_PATH).toContain(PG_LIB)
  })

  // The Linux archive's OpenSSL, which pg_net's libcurl verifies HTTPS with, looks for CA
  // certificates in Debian's /usr/lib/ssl. On Fedora, RHEL or openSUSE that is not there, and every
  // pg_net request to an https URL failed its certificate check. OpenSSL reads SSL_CERT_FILE first.
  it("points OpenSSL at the host's CA bundle when the Debian layout is missing", () => {
    const fedora = (path: string): boolean => path === "/etc/pki/tls/certs/ca-bundle.crt"
    const env = pgSpawnEnv(PG_BIN, "linux", {}, fedora)
    expect(env.SSL_CERT_FILE).toBe("/etc/pki/tls/certs/ca-bundle.crt")
  })

  it("leaves OpenSSL's own paths where the Debian layout is there, or the shell chose", () => {
    const debian = (path: string): boolean => path === "/usr/lib/ssl/certs" || path === "/etc/ssl/certs/ca-certificates.crt"
    expect(pgSpawnEnv(PG_BIN, "linux", {}, debian).SSL_CERT_FILE).toBeUndefined()
    const chosen = pgSpawnEnv(PG_BIN, "linux", { SSL_CERT_FILE: "/mine.pem" }, () => true)
    expect(chosen.SSL_CERT_FILE).toBe("/mine.pem")
    expect(pgSpawnEnv(PG_BIN, "darwin", {}, () => true).SSL_CERT_FILE).toBeUndefined()
  })
})
