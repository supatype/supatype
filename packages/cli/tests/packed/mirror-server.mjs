// A static copy of the release CDN for the packed-install test: serves the directory given as the
// first argument on a free local port, and prints the port as the first line on stdout.
//
// Its own process, because the test drives the CLI with spawnSync, which blocks the test's event
// loop: a server inside the test process could not answer the download it was waiting on.
//
// Once a file called TAMPER exists in that directory, every archive is served with its last byte
// flipped, so the test can check that a download failing its signed checksum is refused.
import { existsSync, readFileSync } from "node:fs"
import { createServer } from "node:http"
import { join } from "node:path"

const root = process.argv[2]
if (root === undefined) throw new Error("usage: mirror-server.mjs <root>")

function body(pathname) {
  const bytes = readFileSync(join(root, decodeURIComponent(pathname)))
  if (pathname.includes("supatype-cli-") && existsSync(join(root, "TAMPER"))) {
    bytes.writeUInt8(bytes.readUInt8(bytes.length - 1) ^ 0xff, bytes.length - 1)
  }
  return bytes
}

const server = createServer((req, res) => {
  try {
    res.end(body(new URL(req.url ?? "/", "http://mirror").pathname))
  } catch {
    res.statusCode = 404
    res.end()
  }
})

server.listen(0, "127.0.0.1", () => {
  const address = server.address()
  process.stdout.write(`${typeof address === "object" && address !== null ? address.port : ""}\n`)
})
