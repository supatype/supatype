import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import ts from "typescript"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { functionTemplateSource } from "../src/functions-template.js"

/**
 * The hello function a new project starts with. It read `req.json()` on every POST, so a POST with
 * no body (`curl -X POST`, the dashboard's invoke with nothing typed) answered 500 "Unexpected end of
 * JSON input", which reads to a new user as the platform being broken (review of round 7, item C12).
 */
type Handler = (req: Request, ctx: { publicUrl: string }) => Promise<Response>

let dir: string
let handler: Handler

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "supatype-function-template-"))
  const js = ts.transpileModule(functionTemplateSource("hello"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const file = join(dir, "hello.mjs")
  writeFileSync(file, js, "utf8")
  const loaded: unknown = await import(pathToFileURL(file).href)
  if (!isHandlerModule(loaded)) throw new Error("the template has no default export")
  handler = loaded.default
})

function isHandlerModule(value: unknown): value is { default: Handler } {
  return typeof value === "object" && value !== null && "default" in value && typeof value.default === "function"
}

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const ctx = { publicUrl: "http://localhost:18471" }
const post = (body?: string): Request => new Request("http://localhost/hello", { method: "POST", ...(body !== undefined && { body }) })

describe("the hello function template", () => {
  it("answers a POST with no body, as it answers a GET", async () => {
    const res = await handler(post(), ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ message: "Hello from hello!", publicUrl: ctx.publicUrl })
  })

  it("echoes a JSON body", async () => {
    const res = await handler(post(JSON.stringify({ name: "Ada" })), ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ message: "Hello from hello!", received: { name: "Ada" }, publicUrl: ctx.publicUrl })
  })

  it("answers 400, saying why, when the body is not JSON", async () => {
    const res = await handler(post("{not json"), ctx)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "The request body is not valid JSON" })
  })
})
