/**
 * Function discovery over symlinks, the layout a Kubernetes ConfigMap volume produces:
 *
 *   functions/
 *     ..2026_11_13/hello/index.ts     (the real files)
 *     ..data -> ..2026_11_13
 *     hello  -> ..data/hello
 *     ping.ts -> ..data/ping.ts
 */
import { assertEquals } from "jsr:@std/assert@1"
import { discoverRoutes } from "../discover.ts"

const MAIN = new URL("../main.ts", import.meta.url).href

const HANDLER = 'export default () => new Response("ok")\n'

/** A symlink; on Windows a relative target must use backslashes or the link is unreadable. */
function link(target: string, path: string, options: { type: "dir" | "file" }): Promise<void> {
  const native = Deno.build.os === "windows" ? target.replaceAll("/", "\\") : target
  return Deno.symlink(native, path, options)
}

async function configMapMount(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "cm-mount-" })
  const real = `${root}/..2026_11_13`
  await Deno.mkdir(`${real}/hello`, { recursive: true })
  await Deno.mkdir(`${real}/orders`, { recursive: true })
  await Deno.writeTextFile(`${real}/hello/index.ts`, HANDLER)
  await Deno.writeTextFile(`${real}/orders/index.ts`, HANDLER)
  await Deno.writeTextFile(`${real}/ping.ts`, HANDLER)
  await link("..2026_11_13", `${root}/..data`, { type: "dir" })
  await link("..data/hello", `${root}/hello`, { type: "dir" })
  await link("..data/orders", `${root}/orders`, { type: "dir" })
  await link("..data/ping.ts", `${root}/ping.ts`, { type: "file" })
  return root
}

Deno.test("the worker loads each function of a ConfigMap mount exactly once", async () => {
  const root = await configMapMount()
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-net", "--allow-env", "--allow-read", MAIN],
    env: { PORT: "0", SUPATYPE_FUNCTIONS_ROOT: root },
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).spawn()
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let output = ""
  try {
    while (!/handler\(s\)/.test(output)) {
      const chunk = await reader.read()
      if (chunk.done) break
      output += decoder.decode(chunk.value, { stream: true })
    }
  } finally {
    child.kill()
    await reader.cancel().catch(() => undefined)
    await child.stderr.cancel().catch(() => undefined)
    await child.status
  }
  assertEquals(/(\d+) handler\(s\)/.exec(output)?.[1], "3", output)
})

Deno.test("discovery follows links to directories and files, and ignores the hidden entries", async () => {
  const root = await configMapMount()
  const routes = await discoverRoutes(root)
  assertEquals(routes.map((route) => route.name), ["hello", "orders", "ping"])
})

Deno.test("discovery refuses a link that resolves outside the root", async () => {
  const outside = await Deno.makeTempDir({ prefix: "cm-outside-" })
  await Deno.mkdir(`${outside}/evil`)
  await Deno.writeTextFile(`${outside}/evil/index.ts`, HANDLER)
  await Deno.writeTextFile(`${outside}/loose.ts`, HANDLER)
  const root = await configMapMount()
  await link(`${outside}/evil`, `${root}/evil`, { type: "dir" })
  await link(`${outside}/loose.ts`, `${root}/loose.ts`, { type: "file" })
  const routes = await discoverRoutes(root)
  assertEquals(routes.map((route) => route.name), ["hello", "orders", "ping"])
})

Deno.test("discovery survives cyclic and dangling links", async () => {
  const root = await configMapMount()
  await link("loop-b", `${root}/loop-a`, { type: "dir" })
  await link("loop-a", `${root}/loop-b`, { type: "dir" })
  await link("nowhere", `${root}/dangling`, { type: "dir" })
  await link(".", `${root}/self`, { type: "dir" })
  const routes = await discoverRoutes(root)
  assertEquals(routes.map((route) => route.name), ["hello", "orders", "ping"])
})

Deno.test("a single-function worker finds only that function", async () => {
  const root = await configMapMount()
  const routes = await discoverRoutes(root, "orders")
  assertEquals(routes.map((route) => route.name), ["orders"])
})
