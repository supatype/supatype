/**
 * `supatype hooks` — scaffold and inspect model hooks.
 *
 * Separate from `supatype functions` because the two are different things wearing the same runtime.
 * A function is a **public endpoint**: anyone holding the anon key can invoke it. A hook is
 * **procedural** — only the API server calls it, around a write, and the gateway refuses the route
 * from outside. Keeping them in separate directories is what makes that boundary structural instead
 * of a list somebody has to maintain.
 */
import type { Command } from "commander"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { loadConfig, loadSchemaAst } from "../config.js"
import { hooksPathFromProject, schemaPathFromProject } from "../project-config.js"
import { declaredHooks, hooksReport } from "../model-hooks.js"
import { error, info, plain } from "../ui/messages.js"

export function registerHooks(program: Command): void {
  const hooksCmd = program
    .command("hooks")
    .description("Manage model hooks (procedural handlers the API runs around a write)")

  hooksCmd
    .command("new <name>")
    .description("Scaffold a hook handler")
    .action((name: string) => {
      scaffoldHook(process.cwd(), name)
    })

  hooksCmd
    .command("list")
    .description("Show the hooks the schema declares and whether each one can run")
    .action(() => {
      const cwd = process.cwd()
      const config = loadConfig(cwd)
      const ast = loadSchemaAst(schemaPathFromProject(config, cwd), cwd)
      const report = hooksReport(cwd, hooksPathFromProject(config, cwd), ast)

      if (report.declared.length === 0) {
        info("No model declares a hook.")
        return
      }
      for (const hook of report.declared) {
        const broken = report.missing.some((m) => m.model === hook.model && m.event === hook.event)
        plain(`  ${broken ? "✗" : "•"} ${hook.model}.${hook.event} → ${hook.function}`)
      }
      if (report.missing.length > 0) {
        plain("\n  ✗ names a handler that does not exist, so that hook never fires.")
      }
    })
}

function scaffoldHook(cwd: string, name: string): void {
  const config = loadConfig(cwd)
  const hooksDir = hooksPathFromProject(config, cwd)
  const dir = join(hooksDir, name)

  if (existsSync(dir)) {
    error(`Hook "${name}" already exists at ${relative(cwd, dir)}`)
    process.exit(1)
  }

  const ast = loadSchemaAst(schemaPathFromProject(config, cwd), cwd)
  const declared = declaredHooks(ast).filter((hook) => hook.function === name)

  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "index.ts"), handlerTemplate(name, declared), "utf8")

  info(`Created hook: ${relative(cwd, join(dir, "index.ts"))}`)
  if (declared.length === 0) {
    // Scaffolding a handler nothing calls is easy to do and impossible to notice, since a hook that
    // is never referenced simply never runs.
    plain("")
    plain("  No model references it yet. Add it to a model's meta:")
    plain(`    hooks: { beforeChange: "${name}" }`)
    plain("  then run `supatype push` to generate its types and register it.")
  } else {
    plain("")
    for (const hook of declared) {
      plain(`  Wired to ${hook.model}.${hook.event}`)
    }
  }
}

/**
 * The scaffold deliberately imports from `../_supatype/hooks.ts`, which `push` generates.
 *
 * Before the first push that file does not exist, so the handler will not compile — which is the
 * honest state: the types come from the schema, and a handler typed against a model that has not been
 * pushed is a handler typed against a guess.
 */
function handlerTemplate(name: string, declared: { model: string; event: string }[]): string {
  const event = declared[0]?.event ?? "beforeChange"
  const model = declared[0]?.model ?? "YourModel"

  if (event.startsWith("after")) {
    return `// ${name} — model hook (${event})
//
// Runs after the write has succeeded. It cannot change or undo it: a rejection here would be a
// rejection of something that already happened. Failures are logged, not surfaced to the caller.

import { hook, type AfterChange } from "../_supatype/hooks.ts"

const handler: AfterChange<"your_table"> = async (ctx) => {
  console.log(\`\${ctx.table} \${ctx.operation} by \${ctx.user?.sub ?? "anon"}\`)
}

export default hook(handler)
`
  }

  return `// ${name} — model hook (${event}) for ${model}
//
// Runs before the write reaches Postgres, so it can reject it or rewrite the body.
//
// Not a security boundary: hooks fire for writes through the API, and direct SQL, seeds and anything
// holding the service role bypass them. Invariants belong in the model's access rules or a CHECK.

import { hook, type BeforeChange } from "../_supatype/hooks.ts"

const handler: BeforeChange<"your_table"> = async (ctx) => {
  if (ctx.operation === "insert") {
    // \`ctx.rows\` is the submitted rows, typed from the model.
    return { rows: ctx.rows }
  }

  // \`ctx.patch\` is the submitted partial; \`ctx.previous()\` reads the rows about to change.
  // Those come back as stored — unmasked — so do not echo them into a rejection message.
  return {}

  // Reject with a message the caller sees, and a status of your choosing:
  //   return { reject: "A post needs a title" }
  //   return { reject: { message: "Already exists", status: 409, code: "duplicate" } }
}

export default hook(handler)
`
}
