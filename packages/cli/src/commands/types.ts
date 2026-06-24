import type { Command } from "commander"
import { existsSync, readFileSync } from "node:fs"
import { resolve, relative } from "node:path"
import ts from "typescript"
import { loadConfig } from "../config.js"
import { error, plain } from "../ui/messages.js"

export function registerTypes(program: Command): void {
  const types = program.command("types").description("Type generation and validation utilities")

  types
    .command("check")
    .description("Validate generated client augmentation wiring")
    .action(() => {
      const cwd = process.cwd()
      const config = loadConfig(cwd)
      const augmentationPath = resolve(cwd, config.output?.client ?? "supatype/generated/index.d.ts")

      const errors: string[] = []

      if (!existsSync(augmentationPath)) {
        errors.push(
          `Missing generated augmentation file: ${relative(cwd, augmentationPath)}.\nRun: supatype generate`,
        )
      }

      const tsconfigPath = resolve(cwd, "tsconfig.json")
      if (!existsSync(tsconfigPath)) {
        errors.push("Missing tsconfig.json in project root.")
      } else {
        const tsconfigRaw = readFileSync(tsconfigPath, "utf8")
        const parsed = ts.parseConfigFileTextToJson(tsconfigPath, tsconfigRaw)
        const cfg = (parsed.config ?? {}) as { include?: unknown; files?: unknown }
        const include = Array.isArray(cfg.include) ? cfg.include.map(String) : []
        const files = Array.isArray(cfg.files) ? cfg.files.map(String) : []
        const relAug = toPosix(relative(cwd, augmentationPath))
        const coveredByFiles = files.includes(relAug)
        const coveredByInclude = include.some((entry) => {
          if (entry.includes("**")) return relAug.startsWith(entry.split("**")[0] ?? "")
          if (entry.endsWith("*.ts") || entry.endsWith("*.d.ts")) {
            return relAug.startsWith(entry.replace(/\*\.d?ts$/, ""))
          }
          return relAug === entry || relAug.startsWith(entry.replace(/\/$/, "") + "/")
        })
        if (!coveredByFiles && !coveredByInclude) {
          errors.push(
            `tsconfig.json does not include ${relAug}. Add it to "include" or "files" so module augmentation is visible to TypeScript.`,
          )
        }
      }

      const packageJsonPath = resolve(cwd, "package.json")
      if (existsSync(packageJsonPath)) {
        const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
          dependencies?: Record<string, string>
          devDependencies?: Record<string, string>
        }
        const hasClient =
          (pkg.dependencies && "@supatype/client" in pkg.dependencies) ||
          (pkg.devDependencies && "@supatype/client" in pkg.devDependencies)
        if (!hasClient) {
          errors.push('package.json is missing "@supatype/client" dependency.')
        }
      }

      if (errors.length > 0) {
        for (const err of errors) error(err)
        process.exit(1)
      }

      plain("types check passed")
    })
}

function toPosix(path: string): string {
  return path.replace(/\\/g, "/")
}
