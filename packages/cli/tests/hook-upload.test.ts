import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { ADAPTER_KEY, readHookUpload } from "../src/hook-upload.js"

function project(): { cwd: string; hooks: string } {
  const cwd = mkdtempSync(join(tmpdir(), "supatype-hook-upload-"))
  const hooks = join(cwd, "hooks")
  mkdirSync(hooks, { recursive: true })
  return { cwd, hooks }
}

function writeHook(hooks: string, name: string, source: string, extra?: Record<string, string>): void {
  const dir = join(hooks, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "index.ts"), source, "utf8")
  for (const [file, contents] of Object.entries(extra ?? {})) {
    writeFileSync(join(dir, file), contents, "utf8")
  }
}

/** An AST shaped as the extractor produces, carrying one hooked model. */
function astWith(hooks: Record<string, string>): unknown {
  return {
    models: [
      {
        name: "Post",
        fields: [],
        annotations: {
          db: { tableName: "posts" },
          platform: {
            hooks: Object.fromEntries(
              Object.entries(hooks).map(([event, fn]) => [event, { function: fn }]),
            ),
          },
        },
      },
    ],
  }
}

const HANDLER = `import { hook, type BeforeChange } from "../_supatype/hooks.ts"

const moderate: BeforeChange<"posts"> = async () => ({})
export default hook(moderate)
`

describe("readHookUpload", () => {
  it("is null when the schema names no hooks", () => {
    const { cwd, hooks } = project()
    expect(readHookUpload(cwd, hooks, astWith({}))).toBeNull()
  })

  it("rewrites the generated adapter import to the flattened name", () => {
    // The nested path cannot survive flattening, and this is the specifier our own scaffold writes.
    const { cwd, hooks } = project()
    writeHook(hooks, "moderate-post", HANDLER)

    const upload = readHookUpload(cwd, hooks, astWith({ beforeChange: "moderate-post" }))
    expect(upload?.handlers).toHaveLength(1)
    expect(upload?.handlers[0]?.source).toContain(`./${ADAPTER_KEY}`)
    expect(upload?.handlers[0]?.source).not.toContain("../_supatype/hooks.ts")
  })

  it("uploads only the handlers the schema names", () => {
    // An unnamed handler would sit on the worker holding the service-role key with nothing able to
    // call it. Uploading it buys nothing and widens what runs with that credential.
    const { cwd, hooks } = project()
    writeHook(hooks, "moderate-post", HANDLER)
    writeHook(hooks, "abandoned", HANDLER)

    const upload = readHookUpload(cwd, hooks, astWith({ beforeChange: "moderate-post" }))
    expect(upload?.handlers.map((h) => h.name)).toEqual(["moderate-post"])
  })

  it("carries the hook map alongside the sources", () => {
    // Both halves in one payload: a map naming a handler whose source has not arrived is the failure
    // this whole feature is meant to avoid.
    const { cwd, hooks } = project()
    writeHook(hooks, "moderate-post", HANDLER)

    const upload = readHookUpload(cwd, hooks, astWith({ beforeChange: "moderate-post" }))
    expect(upload?.map["posts"]?.["beforeChange"]?.function).toBe("moderate-post")
  })

  it("refuses a hook with a second file rather than dropping it", () => {
    // Silent truncation would deploy successfully and fail at import — which reads to the caller as
    // that table's writes being broken for no visible reason.
    const { cwd, hooks } = project()
    writeHook(hooks, "moderate-post", HANDLER, { "helpers.ts": "export const x = 1\n" })

    expect(() => readHookUpload(cwd, hooks, astWith({ beforeChange: "moderate-post" })))
      .toThrow(/more than one file \(helpers\.ts\)/)
  })

  it("refuses a relative import it cannot resolve after flattening", () => {
    const { cwd, hooks } = project()
    writeHook(hooks, "moderate-post", `import { x } from "./helpers.ts"\nexport default () => x\n`)

    expect(() => readHookUpload(cwd, hooks, astWith({ beforeChange: "moderate-post" })))
      .toThrow(/imports \.\/helpers\.ts/)
  })

  it("leaves bare specifiers and URLs alone", () => {
    // Only relative paths depend on the layout. A hook is expected to import from npm: or https:.
    const { cwd, hooks } = project()
    writeHook(
      hooks,
      "moderate-post",
      `import { z } from "npm:zod"\nimport { j } from "https://esm.sh/joi"\n` + HANDLER,
    )

    const upload = readHookUpload(cwd, hooks, astWith({ beforeChange: "moderate-post" }))
    expect(upload?.handlers).toHaveLength(1)
  })

  it("names the missing handler when a declared hook has no source", () => {
    const { cwd, hooks } = project()

    expect(() => readHookUpload(cwd, hooks, astWith({ beforeChange: "moderate-post" })))
      .toThrow(/moderate-post/)
  })
})
