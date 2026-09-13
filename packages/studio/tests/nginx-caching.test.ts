import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * The caching contract in Studio's nginx config, pinned here because neither half of it fails
 * anywhere else.
 *
 * The config file itself carries the reasoning. What this file adds is a failure: a stale-bundle
 * regression only shows up when somebody upgrades Studio in place and reloads a real browser, and
 * an asset served without `immutable` costs nothing visible at all. No component test renders an
 * HTTP header, so without these the rules can be deleted in silence.
 */

const CONFIG = readFileSync(fileURLToPath(new URL("../nginx.conf", import.meta.url)), "utf8")

/**
 * The body of a `location <matcher> { ... }` block.
 *
 * Throws rather than returning null: every caller wants the block, and "no such block" is a better
 * failure than an assertion against an empty string. None of the blocks asked for here nests a
 * brace, so the first `}` closes it.
 */
function locationBlock(matcher: string): string {
  const opener = `location ${matcher} {`
  const start = CONFIG.indexOf(opener)
  if (start === -1) throw new Error(`nginx.conf has no "${opener}" block`)
  const from = start + opener.length
  const end = CONFIG.indexOf("}", from)
  if (end === -1) throw new Error(`nginx.conf never closes its "${opener}" block`)
  return CONFIG.slice(from, end)
}

describe("studio nginx caching", () => {
  it("lets the browser keep hashed assets without asking again", () => {
    const assets = locationBlock("/assets/")
    expect(assets).toContain("immutable")
    expect(assets).toMatch(/max-age=\d{7,}/)
  })

  it("sends exactly one Cache-Control for an asset", () => {
    // `expires` emits a `Cache-Control` of its own. Pairing it with an `add_header` sent the header
    // twice with two different values, and which one wins is up to the client.
    const directives = locationBlock("/assets/").match(/add_header Cache-Control|expires\b/g) ?? []
    expect(directives).toHaveLength(1)
  })

  it("misses an asset rather than falling back to the app shell", () => {
    // Without this, a request for a filename from a previous build returns index.html with a 200,
    // so the browser is handed HTML where it expects JavaScript and reports a syntax error.
    expect(locationBlock("/assets/")).toContain("try_files $uri =404")
  })

  it("makes index.html revalidate, so an upgrade is not stuck behind a cached shell", () => {
    // index.html names the hashed assets. A cached copy points at the previous build's filenames,
    // so upgrading Studio in place leaves a tab half-working until something evicts it, and the
    // only fix a user can find is a hard refresh.
    expect(locationBlock("= /index.html")).toContain('Cache-Control "no-cache"')
  })

  it("makes config.js revalidate, since its contents change while its URL does not", () => {
    // Written at container start from SUPATYPE_CLOUD_JSON. A cached copy points Studio at the API
    // of whatever was deployed there before.
    expect(locationBlock("= /config.js")).toContain('Cache-Control "no-cache"')
  })

  it("carries header buffers matching the gateway's, for a shared localhost cookie jar", () => {
    // Cookies are not scoped by port, so Studio is sent every cookie set by every other project on
    // localhost, and nginx's default buffers are not sized for that. The failure is an opaque
    // "Request header or cookie too large" from a component nobody configured.
    //
    // The value tracks Kong's on purpose: a request that clears one hop and fails the next is worse
    // to diagnose than one that fails outright.
    expect(CONFIG).toMatch(/large_client_header_buffers\s+4\s+32k;/)
  })
})
