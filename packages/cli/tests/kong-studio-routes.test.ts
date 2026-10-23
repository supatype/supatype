import { describe, expect, it } from "vitest"
import { buildKongDeclarative, type KongDeclarativeOptions } from "../src/kong-config.js"

/**
 * Which upstream Kong sends a request path to, from a rendered `kong.yml`.
 *
 * Read as text (the CLI ships no YAML parser): each service's `url:` and the `paths:` under it.
 * Matching follows Kong: a `~` path is a regex anchored at the start, any other path is a prefix,
 * and the longest matching prefix wins. Studio's API calls (`/studio/session` and the rest) share
 * the `/studio/` prefix with Studio's own pages, so only a longer prefix sends them to the server.
 */
interface KongPath {
  url: string
  path: string
}

function kongPaths(yml: string): KongPath[] {
  const found: KongPath[] = []
  let url = ""
  for (const line of yml.split("\n")) {
    const service = /^ {4}url: (\S+)$/.exec(line)
    if (service?.[1] !== undefined) url = service[1]
    const path = /^ {10}- (\S+)$/.exec(line)
    if (path?.[1] !== undefined && url !== "") found.push({ url, path: path[1] })
  }
  return found
}

function matches(entry: KongPath, requestPath: string): boolean {
  if (entry.path.startsWith("~")) return new RegExp(`^${entry.path.slice(1)}`).test(requestPath)
  return requestPath.startsWith(entry.path)
}

function upstreamFor(yml: string, requestPath: string): string | undefined {
  const candidates = kongPaths(yml).filter((entry) => matches(entry, requestPath))
  const regex = candidates.find((entry) => entry.path.startsWith("~"))
  if (regex) return regex.url
  const longest = candidates.sort((a, b) => b.path.length - a.path.length)[0]
  return longest?.url
}

const SERVER = "http://server:9999"
const SERVER_PATHS = ["/studio/session", "/studio/auth/verify", "/studio/proxy/rest/v1/post"]
const STUDIO_PAGES = ["/studio", "/studio/", "/studio/models/post", "/studio/assets/index.js"]

const LAYOUTS: { name: string; opts: KongDeclarativeOptions; studio: string }[] = [
  { name: "self-host and dev (unified gateway)", opts: { unifiedGateway: true }, studio: "http://studio:3002" },
  {
    name: "dev with Studio's dev server on the host",
    opts: { unifiedGateway: true, studioServiceUrl: "http://host.docker.internal:5173", studioStripPath: false },
    studio: "http://host.docker.internal:5173",
  },
  { name: "split stack", opts: {}, studio: "http://studio:3002" },
]

describe("kong.yml: Studio's API paths reach the server, its pages reach Studio", () => {
  for (const layout of LAYOUTS) {
    const yml = buildKongDeclarative(layout.opts)
    it.each(SERVER_PATHS)(`${layout.name}: %s goes to the server`, (path) => {
      expect(upstreamFor(yml, path)).toBe(SERVER)
    })
    it.each(STUDIO_PAGES)(`${layout.name}: %s goes to Studio`, (path) => {
      expect(upstreamFor(yml, path)).toBe(layout.studio)
    })
  }
})
