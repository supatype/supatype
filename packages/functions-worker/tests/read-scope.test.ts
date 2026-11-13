/**
 * What the image may read. The Dockerfile's CMD names the directories; these tests hold it to
 * that, and run the worker with the same list (paths mapped onto a temp tree) to show a function
 * can read its own project and nothing outside it.
 *
 * Run with `deno task test` from packages/functions-worker.
 */

import { expectEqual, startWorker } from "./worker-harness.ts"

const DOCKERFILE = new URL("../Dockerfile", import.meta.url)

/** The paths the Dockerfile's CMD passes to --allow-read, or undefined when it grants all of the disk. */
async function dockerfileReadPaths(): Promise<string[] | undefined> {
  const cmd = (await Deno.readTextFile(DOCKERFILE)).split("\n").find((line) => line.startsWith("CMD "))
  const flag = cmd === undefined ? undefined : /"--allow-read=([^"]+)"/.exec(cmd)?.[1]
  return flag?.split(",")
}

Deno.test("the image's --allow-read names directories, not the whole disk", async () => {
  const paths = await dockerfileReadPaths()
  expectEqual(JSON.stringify(paths), JSON.stringify(["/app", "/project", "/functions", "/hooks"]), "allow-read paths")
})

/** Reads one file beside the functions and one the test put outside every allowed directory. */
const READER = `export default async function handler() {
  const targets = {
    inside: Deno.env.get("SUPATYPE_FUNCTIONS_ROOT") + "/_data/data.txt",
    outside: Deno.env.get("OUTSIDE_FILE"),
  }
  const out = {}
  for (const [key, path] of Object.entries(targets)) {
    try { out[key] = (await Deno.readTextFile(path)).trim() } catch (e) { out[key] = e.name }
  }
  return Response.json(out)
}
`

Deno.test("a function reads files in its project and is refused anything outside it", async () => {
  const outside = await Deno.makeTempFile({ prefix: "outside-" })
  await Deno.writeTextFile(outside, "secret")
  try {
    const worker = await startWorker(
      { reader: READER, "_data/data.txt": "bundled" },
      { ...Deno.env.toObject(), OUTSIDE_FILE: outside },
      { readFromDockerfile: true },
    )
    try {
      const body = await (await fetch(`${worker.origin}/functions/v1/reader`)).json()
      expectEqual(body.inside, "bundled", "a file in the functions root")
      expectEqual(body.outside, "NotCapable", "a file outside every allowed directory")
    } finally {
      await worker.stop()
    }
  } finally {
    await Deno.remove(outside)
  }
})
