/**
 * `ctx.publicUrl` through the real worker: main.ts started as the image starts it, one function
 * served, its context read back over HTTP.
 *
 * Run with `deno task test` from packages/functions-worker. Outside the image's COPY of `*.ts`, so it
 * never ships.
 */

const MAIN = new URL("../main.ts", import.meta.url).href

/** A function that answers with the two addresses it was handed. */
const ECHO = `export default (_req: Request, ctx: { url: string; publicUrl: string }) =>
  new Response(JSON.stringify({ url: ctx.url, publicUrl: ctx.publicUrl }))
`

interface Worker {
  readonly origin: string
  readonly lines: string[]
  stop(): Promise<void>
}

/** Every variable but the ones under test, so a developer's own shell cannot decide the result. */
function baseEnv(): Record<string, string> {
  const env = Deno.env.toObject()
  delete env["SUPATYPE_PUBLIC_URL"]
  delete env["SUPATYPE_URL"]
  return env
}

async function functionsRoot(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "worker-public-url-" })
  await Deno.mkdir(`${root}/echo`)
  await Deno.writeTextFile(`${root}/echo/index.ts`, ECHO)
  return root
}

/** Collect stdout line by line, resolving once the worker says where it listens. */
function watchStdout(stream: ReadableStream<Uint8Array>, lines: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buffered = ""
    const pump = async (): Promise<void> => {
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        buffered += decoder.decode(chunk.value, { stream: true })
        const parts = buffered.split("\n")
        buffered = parts.pop() ?? ""
        for (const line of parts) {
          lines.push(line)
          const listening = /listening on (http:\/\/[^"\s]+)/.exec(line)
          if (listening?.[1] !== undefined) resolve(listening[1].replace("0.0.0.0", "127.0.0.1"))
        }
      }
      reject(new Error(`worker exited before listening:\n${lines.join("\n")}`))
    }
    pump().catch(reject)
  })
}

async function startWorker(env: Record<string, string>): Promise<Worker> {
  const root = await functionsRoot()
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-net", "--allow-env", "--allow-read", MAIN],
    env: { ...baseEnv(), ...env, PORT: "0", SUPATYPE_FUNCTIONS_ROOT: root },
    clearEnv: true,
    stdout: "piped",
    stderr: "inherit",
  }).spawn()
  const lines: string[] = []
  const origin = await watchStdout(child.stdout, lines)
  return {
    origin,
    lines,
    async stop() {
      child.kill("SIGTERM")
      await child.status
      await Deno.remove(root, { recursive: true })
    },
  }
}

async function contextOf(worker: Worker): Promise<{ url: string; publicUrl: string }> {
  const res = await fetch(`${worker.origin}/functions/v1/echo`)
  const body: unknown = await res.json()
  if (typeof body !== "object" || body === null || !("url" in body) || !("publicUrl" in body)) {
    throw new Error(`unexpected body: ${JSON.stringify(body)}`)
  }
  return { url: String(body.url), publicUrl: String(body.publicUrl) }
}

function expectEqual(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function publicUrlWarnings(lines: readonly string[]): string[] {
  return lines.filter((line) => line.includes('"level":"warn"') && line.includes("SUPATYPE_PUBLIC_URL"))
}

Deno.test("publicUrl is SUPATYPE_PUBLIC_URL, and url is left as it was", async () => {
  const worker = await startWorker({ SUPATYPE_URL: "http://kong:8000", SUPATYPE_PUBLIC_URL: "https://api.acme.dev" })
  try {
    const ctx = await contextOf(worker)
    expectEqual(ctx.publicUrl, "https://api.acme.dev", "publicUrl")
    expectEqual(ctx.url, "http://kong:8000", "url")
    expectEqual(publicUrlWarnings(worker.lines).length, 0, "warnings when the variable is set")
  } finally {
    await worker.stop()
  }
})

Deno.test("publicUrl falls back to url, with one warning at start rather than one per call", async () => {
  const worker = await startWorker({ SUPATYPE_URL: "http://kong:8000" })
  try {
    expectEqual(publicUrlWarnings(worker.lines).length, 1, "warnings before any call")
    const first = await contextOf(worker)
    await contextOf(worker)
    expectEqual(first.publicUrl, "http://kong:8000", "publicUrl fallback")
    expectEqual(publicUrlWarnings(worker.lines).length, 1, "warnings after two calls")
  } finally {
    await worker.stop()
  }
})
