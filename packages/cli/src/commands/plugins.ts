import type { Command } from "commander"
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"
import { spawnSync } from "node:child_process"

// ─── Registration ────────────────────────────────────────────────────────────

export function registerPlugins(program: Command): void {
  const cmd = program
    .command("plugins")
    .description("Manage Supatype plugins (field types, composites, providers, widgets)")

  cmd
    .command("list")
    .description("Show all installed and active plugins")
    .action(() => {
      listPlugins(process.cwd())
    })

  cmd
    .command("search <query>")
    .description("Search npm registry for Supatype plugins")
    .action(async (query: string) => {
      await searchPlugins(query)
    })

  cmd
    .command("add <package>")
    .description("Install a plugin package and register it")
    .action((pkg: string) => {
      addPlugin(process.cwd(), pkg)
    })

  cmd
    .command("remove <package>")
    .description("Uninstall and deregister a plugin")
    .action((pkg: string) => {
      removePlugin(process.cwd(), pkg)
    })

  cmd
    .command("create")
    .description("Scaffold a new plugin project")
    .option("--type <type>", "Plugin type: field, composite, provider, or widget", "field")
    .option("--name <name>", "Plugin name")
    .action((opts: { type: string; name?: string }) => {
      createPlugin(process.cwd(), opts)
    })

  cmd
    .command("validate")
    .description("Validate installed plugins for compatibility and correctness")
    .action(() => {
      validatePlugins(process.cwd())
    })
}

// ─── List ────────────────────────────────────────────────────────────────────

function listPlugins(cwd: string): void {
  const plugins = discoverInstalledPlugins(cwd)

  if (plugins.length === 0) {
    console.log("No Supatype plugins installed.")
    console.log("\nSearch for plugins:  npx supatype plugins search <query>")
    console.log("Create a plugin:    npx supatype plugins create")
    return
  }

  console.log("Installed plugins:\n")
  console.log(`  ${"Name".padEnd(35)} ${"Type".padEnd(14)} ${"Version".padEnd(12)} Status`)
  console.log(`  ${"─".repeat(35)} ${"─".repeat(14)} ${"─".repeat(12)} ${"─".repeat(15)}`)

  for (const p of plugins) {
    const types = p.supatype?.types?.join(", ") ?? "unknown"
    const status = p.compatible ? "active" : "incompatible"
    console.log(`  ${p.name.padEnd(35)} ${types.padEnd(14)} ${p.version.padEnd(12)} ${status}`)
  }
}

// ─── Search ──────────────────────────────────────────────────────────────────

async function searchPlugins(query: string): Promise<void> {
  console.log(`Searching npm for "${query}" supatype plugins...\n`)

  try {
    const searchUrl = `https://registry.npmjs.org/-/v1/search?text=supatype-plugin+${encodeURIComponent(query)}&size=20`
    const res = await fetch(searchUrl, {
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      console.error(`Search failed: ${res.statusText}`)
      return
    }

    const data = await res.json() as {
      objects: Array<{
        package: {
          name: string
          version: string
          description: string
          keywords: string[]
        }
        score: { final: number }
      }>
    }

    if (data.objects.length === 0) {
      console.log("No plugins found.")
      console.log("\nTry a different search term, or create your own plugin:")
      console.log("  npx supatype plugins create")
      return
    }

    console.log(`  ${"Package".padEnd(40)} ${"Version".padEnd(12)} Description`)
    console.log(`  ${"─".repeat(40)} ${"─".repeat(12)} ${"─".repeat(40)}`)

    for (const obj of data.objects) {
      const pkg = obj.package
      const desc = (pkg.description ?? "").slice(0, 50)
      console.log(`  ${pkg.name.padEnd(40)} ${pkg.version.padEnd(12)} ${desc}`)
    }

    console.log(`\nInstall: npx supatype plugins add <package-name>`)
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : "unknown"}`)
  }
}

// ─── Add ─────────────────────────────────────────────────────────────────────

function addPlugin(cwd: string, pkg: string): void {
  console.log(`Installing ${pkg}...`)

  // Detect package manager
  const pm = detectPackageManager(cwd)
  const installCmd = pm === "pnpm" ? ["pnpm", "add", pkg]
    : pm === "yarn" ? ["yarn", "add", pkg]
    : ["npm", "install", pkg]

  const result = spawnSync(installCmd[0]!, installCmd.slice(1), {
    stdio: "inherit",
    cwd,
  })

  if (result.status !== 0) {
    console.error(`Failed to install ${pkg}`)
    process.exit(1)
  }

  // Check compatibility
  const pluginPkgPath = resolvePackageJson(cwd, pkg)
  if (pluginPkgPath) {
    const pkgJson = JSON.parse(readFileSync(pluginPkgPath, "utf8")) as Record<string, unknown>
    const supatype = pkgJson["supatype"] as Record<string, unknown> | undefined

    if (supatype?.["pluginApi"] !== undefined) {
      const pluginApi = supatype["pluginApi"] as number
      if (pluginApi !== 1) {
        console.warn(`\nWarning: ${pkg} targets plugin API v${pluginApi}, current is v1.`)
        console.warn("The plugin may not work correctly.")
      }
    }
  }

  console.log(`\n${pkg} installed and registered.`)
  console.log("Run 'npx supatype plugins list' to see active plugins.")
}

// ─── Remove ──────────────────────────────────────────────────────────────────

function removePlugin(cwd: string, pkg: string): void {
  // Check if the plugin is referenced in the schema
  // This is a best-effort check
  const schemaFiles = findSchemaFiles(cwd)
  for (const file of schemaFiles) {
    const content = readFileSync(file, "utf8")
    if (content.includes(pkg)) {
      console.warn(`Warning: ${pkg} appears to be referenced in ${file}`)
      console.warn("Removing it may break your schema. Proceed with caution.\n")
    }
  }

  console.log(`Removing ${pkg}...`)

  const pm = detectPackageManager(cwd)
  const removeCmd = pm === "pnpm" ? ["pnpm", "remove", pkg]
    : pm === "yarn" ? ["yarn", "remove", pkg]
    : ["npm", "uninstall", pkg]

  const result = spawnSync(removeCmd[0]!, removeCmd.slice(1), {
    stdio: "inherit",
    cwd,
  })

  if (result.status !== 0) {
    console.error(`Failed to remove ${pkg}`)
    process.exit(1)
  }

  console.log(`${pkg} removed.`)
}

// ─── Create ──────────────────────────────────────────────────────────────────

function createPlugin(cwd: string, opts: { type: string; name?: string }): void {
  const validTypes = ["field", "composite", "provider", "widget"]
  if (!validTypes.includes(opts.type)) {
    console.error(`Invalid plugin type "${opts.type}". Must be one of: ${validTypes.join(", ")}`)
    process.exit(1)
  }

  const name = opts.name ?? `supatype-plugin-my-${opts.type}`
  const pluginDir = resolve(cwd, name)

  if (existsSync(pluginDir)) {
    console.error(`Directory "${name}" already exists.`)
    process.exit(1)
  }

  mkdirSync(pluginDir, { recursive: true })
  mkdirSync(join(pluginDir, "src"), { recursive: true })

  // package.json
  writeFileSync(join(pluginDir, "package.json"), JSON.stringify({
    name,
    version: "0.1.0",
    description: `Supatype ${opts.type} plugin`,
    type: "module",
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports: {
      ".": {
        import: "./dist/index.js",
        types: "./dist/index.d.ts",
      },
    },
    keywords: ["supatype", "supatype-plugin"],
    supatype: {
      pluginApi: 1,
      types: [opts.type],
    },
    scripts: {
      build: "tsc",
      typecheck: "tsc --noEmit",
    },
    dependencies: {
      "@supatype/plugin-sdk": "^0.1.0",
    },
    devDependencies: {
      typescript: "^5",
    },
  }, null, 2) + "\n", "utf8")

  // tsconfig.json
  writeFileSync(join(pluginDir, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "Node16",
      moduleResolution: "Node16",
      outDir: "dist",
      rootDir: "src",
      declaration: true,
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
    },
    include: ["src"],
  }, null, 2) + "\n", "utf8")

  // Source file based on type
  const sourceContent = generatePluginTemplate(opts.type, name)
  writeFileSync(join(pluginDir, "src/index.ts"), sourceContent, "utf8")

  console.log(`\nCreated plugin project: ${name}/\n`)
  console.log("  Files:")
  console.log(`    ${name}/package.json`)
  console.log(`    ${name}/tsconfig.json`)
  console.log(`    ${name}/src/index.ts`)
  console.log(`\n  Next steps:`)
  console.log(`    cd ${name}`)
  console.log(`    npm install`)
  console.log(`    npm run build`)
  console.log(`    npx supatype plugins validate`)
}

function generatePluginTemplate(type: string, name: string): string {
  switch (type) {
    case "field":
      return `import { defineFieldType } from "@supatype/plugin-sdk"

export default defineFieldType({
  name: "${name.replace(/.*plugin-/, "")}",
  pgType: "TEXT",
  tsType: "string",

  validate(value) {
    if (typeof value !== "string") return "Must be a string"
    return null
  },

  serialise(value: string) {
    return value
  },

  deserialise(raw) {
    return String(raw)
  },

  filterOperators: ["eq", "neq", "in", "like"],
  // widgetPath: "./src/Widget.tsx",
})
`
    case "composite":
      return `import { defineComposite } from "@supatype/plugin-sdk"

export default defineComposite({
  name: "${name.replace(/.*plugin-/, "")}",
  label: "${name.replace(/.*plugin-/, "").replace(/-/g, " ").replace(/\b\w/g, l => l.toUpperCase())}",
  fields: [
    { name: "example_field", type: "text", required: false },
  ],
  adminGroup: {
    collapsible: true,
    defaultCollapsed: false,
  },
})
`
    case "provider":
      return `import { defineProvider, type EmailProvider } from "@supatype/plugin-sdk"

interface MyProviderConfig {
  apiKey: string
  region?: string
}

export default defineProvider<MyProviderConfig>({
  name: "${name.replace(/.*plugin-/, "")}",
  category: "email",
  label: "${name.replace(/.*plugin-/, "").replace(/-/g, " ").replace(/\b\w/g, l => l.toUpperCase())}",
  configSchema: {
    apiKey: { type: "string", label: "API Key", required: true, secret: true },
    region: { type: "select", label: "Region", options: ["us-east-1", "eu-west-1"] },
  },
  create(config): EmailProvider {
    return {
      async send(params) {
        // Implement email sending using config.apiKey
        console.log("Sending email to", params.to)
        return { messageId: "msg_" + Date.now() }
      },
    }
  },
})
`
    case "widget":
      return `import { defineWidget } from "@supatype/plugin-sdk"

export default defineWidget({
  name: "${name.replace(/.*plugin-/, "")}",
  label: "${name.replace(/.*plugin-/, "").replace(/-/g, " ").replace(/\b\w/g, l => l.toUpperCase())}",
  compatibleTypes: ["text", "varchar"],
  componentPath: "./src/Widget.tsx",
})
`
    default:
      return `// Unknown plugin type: ${type}\n`
  }
}

// ─── Validate ────────────────────────────────────────────────────────────────

function validatePlugins(cwd: string): void {
  const plugins = discoverInstalledPlugins(cwd)

  if (plugins.length === 0) {
    console.log("No plugins to validate.")
    return
  }

  let hasErrors = false

  for (const p of plugins) {
    const issues: string[] = []

    if (!p.supatype) {
      issues.push("Missing 'supatype' field in package.json")
    } else {
      if (!p.supatype.pluginApi) {
        issues.push("Missing supatype.pluginApi version")
      } else if (p.supatype.pluginApi !== 1) {
        issues.push(`Targets plugin API v${p.supatype.pluginApi}, current is v1`)
      }
      if (!p.supatype.types || p.supatype.types.length === 0) {
        issues.push("Missing supatype.types array")
      }
    }

    if (issues.length === 0) {
      console.log(`  ✓ ${p.name} — valid`)
    } else {
      hasErrors = true
      console.log(`  ✗ ${p.name}`)
      for (const issue of issues) {
        console.log(`    - ${issue}`)
      }
    }
  }

  if (hasErrors) {
    console.log("\nSome plugins have issues. Fix them before deploying.")
    process.exit(1)
  } else {
    console.log("\nAll plugins are valid.")
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface DiscoveredPlugin {
  name: string
  version: string
  supatype?: {
    pluginApi?: number | undefined
    types?: string[] | undefined
  } | undefined
  compatible: boolean
}

function discoverInstalledPlugins(cwd: string): DiscoveredPlugin[] {
  const nodeModulesDir = resolve(cwd, "node_modules")
  if (!existsSync(nodeModulesDir)) return []

  const plugins: DiscoveredPlugin[] = []

  // Read package.json to find dependencies
  const pkgJsonPath = resolve(cwd, "package.json")
  if (!existsSync(pkgJsonPath)) return []

  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as Record<string, Record<string, string>>
  const deps = {
    ...pkgJson["dependencies"],
    ...pkgJson["devDependencies"],
  }

  for (const depName of Object.keys(deps)) {
    const depPkgPath = resolvePackageJson(cwd, depName)
    if (!depPkgPath) continue

    try {
      const depPkg = JSON.parse(readFileSync(depPkgPath, "utf8")) as Record<string, unknown>

      // Check if it's a Supatype plugin
      const keywords = (depPkg["keywords"] as string[] | undefined) ?? []
      const supatype = depPkg["supatype"] as Record<string, unknown> | undefined

      if (keywords.includes("supatype-plugin") || supatype) {
        plugins.push({
          name: depName,
          version: (depPkg["version"] as string) ?? "unknown",
          supatype: supatype ? {
            pluginApi: supatype["pluginApi"] as number | undefined,
            types: supatype["types"] as string[] | undefined,
          } : undefined,
          compatible: !supatype?.["pluginApi"] || supatype["pluginApi"] === 1,
        })
      }
    } catch {
      // Skip packages we can't read
    }
  }

  return plugins
}

function resolvePackageJson(cwd: string, packageName: string): string | null {
  // Handle scoped packages
  const parts = packageName.startsWith("@") ? packageName.split("/") : [packageName]
  const pkgPath = resolve(cwd, "node_modules", ...parts, "package.json")
  return existsSync(pkgPath) ? pkgPath : null
}

function detectPackageManager(cwd: string): "pnpm" | "yarn" | "npm" {
  if (existsSync(resolve(cwd, "pnpm-lock.yaml"))) return "pnpm"
  if (existsSync(resolve(cwd, "yarn.lock"))) return "yarn"
  return "npm"
}

function findSchemaFiles(cwd: string): string[] {
  const schemaDir = resolve(cwd, "supatype/schema")
  if (!existsSync(schemaDir)) return []

  const files: string[] = []
  try {
    const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs")
    const entries = readdirSync(schemaDir)
    for (const entry of entries) {
      const fullPath = join(schemaDir, entry)
      if (statSync(fullPath).isFile() && entry.endsWith(".ts")) {
        files.push(fullPath)
      }
    }
  } catch {
    // Ignore errors
  }
  return files
}
