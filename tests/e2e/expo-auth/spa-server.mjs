/**
 * Serves the Expo web export for the expo-auth suite, the way a static host serves an SPA: a file
 * when there is one, index.html when there is not. The second half matters here, because the auth
 * redirects land on /auth/callback, which no file backs.
 *
 *   node spa-server.mjs <dist-dir> <port>
 */
import { createReadStream, existsSync, statSync } from "node:fs"
import { createServer } from "node:http"
import { extname, join, normalize, resolve } from "node:path"

const [distArg, portArg] = process.argv.slice(2)
if (distArg === undefined || portArg === undefined) {
  console.error("usage: spa-server.mjs <dist-dir> <port>")
  process.exit(1)
}
const dist = resolve(distArg)
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
}

function fileFor(pathname) {
  const candidate = join(dist, normalize(decodeURIComponent(pathname)))
  if (candidate.startsWith(dist) && existsSync(candidate) && statSync(candidate).isFile()) return candidate
  return join(dist, "index.html")
}

createServer((req, res) => {
  const file = fileFor(new URL(req.url ?? "/", "http://localhost").pathname)
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" })
  createReadStream(file).pipe(res)
}).listen(Number(portArg), "127.0.0.1", () => console.log(`serving ${dist} on :${portArg}`))
