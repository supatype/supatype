/**
 * The storage service's entry point. `--self-test` renders one image through sharp and exits, so a
 * packaged release can be checked on the machine it was built for without a database.
 */

/** Renders a generated image through the same transform the routes use; 0 when it worked. */
async function selfTest(): Promise<number> {
  const { default: sharp } = await import("sharp")
  const { transformImage } = await import("./transform.js")
  const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#2a7" } }).png().toBuffer()
  const out = await transformImage(png, { width: 8, format: "webp" })
  const width = (await sharp(out.buffer).metadata()).width
  console.log(`supatype-storage self-test: ${out.contentType} ${width}px`)
  return out.contentType === "image/webp" && width === 8 ? 0 : 1
}

async function serve(): Promise<void> {
  const { createServer } = await import("./server.js")
  const port = parseInt(process.env["PORT"] ?? "5000", 10)
  const host = process.env["HOST"] ?? "0.0.0.0"
  createServer().listen(port, host, () => {
    console.log(`supatype-storage listening on ${host}:${port}`)
  })
}

/** Ends the process with why `err` stopped `what`. */
function fail(what: string): (err: unknown) => never {
  return (err) => {
    console.error(`supatype-storage ${what} failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

if (process.argv.includes("--self-test")) {
  selfTest().then((code) => process.exit(code), fail("self-test"))
} else {
  serve().catch(fail("start"))
}
