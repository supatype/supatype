/**
 * `supatype hooks`: scaffold and inspect model hooks.
 *
 * Separate from `supatype functions` because the two are different things wearing the same runtime.
 * A function is a **public endpoint**: anyone holding the anon key can invoke it. A hook is
 * **procedural**: only the API server calls it, around a write, and the gateway refuses the route
 * from outside. Keeping them in separate directories is what makes that boundary structural instead
 * of a list somebody has to maintain.
 */
import type { Command } from "commander"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { loadConfig, loadSchemaAst } from "../config.js"
import { hooksPathFromProject, schemaPathFromProject } from "../project-config.js"
import { declaredHooks, declaredValidators, ensureHooksModule, hookTableOf, hooksReport, type DeclaredValidator } from "../model-hooks.js"
import { isAfterHookEvent, type AfterHookEvent } from "../hook-columns.js"
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

      if (report.declared.length === 0 && report.validators.length === 0) {
        info("No model declares a hook or a field validator.")
        return
      }
      for (const hook of report.declared) {
        const broken = report.missing.some((m) => m.model === hook.model && m.event === hook.event)
        plain(`  ${broken ? "✗" : "•"} ${hook.model}.${hook.event} → ${hook.function}`)
      }
      for (const validator of report.validators) {
        const broken = report.validatorsMissing.some((m) => m.model === validator.model && m.field === validator.field)
        plain(`  ${broken ? "✗" : "•"} ${validator.model}.${validator.field} (validator) → ${validator.function}`)
      }
      if (report.missing.length > 0 || report.validatorsMissing.length > 0) {
        plain("\n  ✗ names a handler that does not exist, so that hook or validator never runs.")
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
  const validators = declaredValidators(ast).filter((validator) => validator.function === name)

  mkdirSync(dir, { recursive: true })
  const table = declared[0] === undefined ? undefined : hookTableOf(ast, declared[0].model)
  const source = validators[0] !== undefined && declared.length === 0 ? validatorTemplate(name, validators[0]) : handlerTemplate(name, declared, table)
  writeFileSync(join(dir, "index.ts"), source, "utf8")

  info(`Created hook: ${relative(cwd, join(dir, "index.ts"))}`)
  // The handler imports the generated adapter; written now when missing, so it loads before a push.
  const adapter = ensureHooksModule(cwd, hooksDir, ast)
  if (adapter !== null) info(`Hook handler types written to ${adapter}`)
  sayWiring(name, declared, validators)
}

/** Which model events the new hook is wired to, or how to wire it when none names it yet. */
function sayWiring(name: string, declared: { model: string; event: string }[], validators: DeclaredValidator[]): void {
  if (declared.length === 0 && validators.length > 0) {
    plain("")
    for (const validator of validators) plain(`  Wired to ${validator.model}.${validator.field} (validator)`)
  } else if (declared.length === 0) {
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

/** The scaffold for a field validator: the value of one field in, `true` or the message to show out. */
function validatorTemplate(name: string, validator: DeclaredValidator): string {
  const table = JSON.stringify(validator.table ?? "your_table")
  const field = JSON.stringify(validator.field)
  return `// ${name}: field validator for ${validator.model}.${validator.field}
//
// Runs before the write reaches Postgres, on this one field's value. Return \`true\` to accept it, or a
// message to refuse: the caller sees it attached to the field, so a form can show it on the input.

import { fieldValidator, type FieldValidator } from "../_supatype/hooks.ts"

const validate: FieldValidator<${table}, ${field}> = (ctx) => {
  // \`ctx.value\` is the submitted value, typed from the model.
  void ctx.value
  return true
}

export default fieldValidator(validate)
`
}

/** The scaffold for an `afterChange` or `afterDelete` hook, typed as the event it is wired to. */
function afterHandlerTemplate(name: string, event: AfterHookEvent, tableType: string): string {
  const type = event === "afterDelete" ? "AfterDelete" : "AfterChange"
  return `// ${name}: model hook (${event})
//
// Runs after the write has committed, for every writer: the API, Studio, SQL and functions. It
// cannot change or undo it. Failures are retried, then logged, never surfaced to the caller.
//
// Delivery is at least once, so the same change can arrive twice: \`ctx.deliveryId\` is the same
// each time, so keep the ones you have handled if a repeat would do harm.

import { hook, type ${type} } from "../_supatype/hooks.ts"

const handler: ${type}<${tableType}> = async (ctx) => {
  console.log(\`\${ctx.table} \${ctx.operation} by \${ctx.user?.sub ?? "anon"} (\${ctx.deliveryId})\`)
}

export default hook(handler)
`
}

/**
 * The scaffold deliberately imports from `../_supatype/hooks.ts`, which `push` generates and
 * `hooks new` writes when it is missing.
 *
 * Until a push wires the hook, that module has no table for it, so the handler does not type-check,
 * which is the honest state: the types come from the schema, and a handler typed against a model
 * that has not been pushed is a handler typed against a guess. It still loads, so the push that
 * wires it is served at once.
 */
function handlerTemplate(name: string, declared: { model: string; event: string }[], table: string | undefined): string {
  const event = declared[0]?.event ?? "beforeChange"
  const model = declared[0]?.model ?? "YourModel"
  // The table of the model that names the hook, as the generated types key it; a placeholder only
  // when no model names it yet.
  const tableType = JSON.stringify(table ?? "your_table")

  if (isAfterHookEvent(event)) return afterHandlerTemplate(name, event, tableType)

  return `// ${name}: model hook (${event}) for ${model}
//
// Runs before the write reaches Postgres, so it can reject it or rewrite the body.
//
// Not a security boundary: hooks fire for every write through the API, service-role key included,
// but direct SQL, seeds and migrations bypass them. Invariants belong in the model's access rules
// or a CHECK.

import { hook, type BeforeChange } from "../_supatype/hooks.ts"

const handler: BeforeChange<${tableType}> = async (ctx) => {
  if (ctx.operation === "insert") {
    // \`ctx.rows\` is the submitted rows, typed from the model.
    return { rows: ctx.rows }
  }

  // \`ctx.patch\` is the submitted partial; \`ctx.previous()\` reads the rows about to change.
  // Those come back as stored, unmasked, so do not echo them into a rejection message.
  return {}

  // Reject with a message the caller sees, and a status of your choosing:
  //   return { reject: "A post needs a title" }
  //   return { reject: { message: "Already exists", status: 409, code: "duplicate" } }
}

export default hook(handler)
`
}
