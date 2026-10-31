/**
 * The real worker for tests: main.ts started as the image starts it, over a functions root holding
 * the functions a test gives it. Outside the image's COPY of `*.ts`, so it never ships.
 */

const MAIN = new URL("../main.ts", import.meta.url).href

export interface Worker {
  readonly origin: string
  readonly lines: string[]
  stop(): Promise<void>
}

/**
 * A temporary functions root with `{name}/index.ts` for each entry of `functions`; a key with a `/`
 * is a file at that path instead, such as a module a function imports.
 */
async function functionsRoot(functions: Record<string, string>): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "worker-test-" })
  for (const [key, source] of Object.entries(functions)) {
    const path = key.includes("/") ? `${root}/${key}` : `${root}/${key}/index.ts`
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true })
    await Deno.writeTextFile(path, source)
  }
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

/** Starts the worker on a free port with `env` (the whole environment) over `functions`. */
export async function startWorker(functions: Record<string, string>, env: Record<string, string>): Promise<Worker> {
  const root = await functionsRoot(functions)
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-net", "--allow-env", "--allow-read", MAIN],
    env: { ...env, PORT: "0", SUPATYPE_FUNCTIONS_ROOT: root },
    clearEnv: true,
    stdout: "piped",
    stderr: "inherit",
  }).spawn()
  const lines: string[] = []
  const stop = async (): Promise<void> => {
    try {
      child.kill("SIGTERM")
    } catch {
      // Already exited, which is how a worker that never listened ends.
    }
    await child.status
    await Deno.remove(root, { recursive: true })
  }
  try {
    return { origin: await watchStdout(child.stdout, lines), lines, stop }
  } catch (err) {
    await stop()
    throw err
  }
}

export function expectEqual(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
