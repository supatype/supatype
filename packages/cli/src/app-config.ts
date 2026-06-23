import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { Node, Project, QuoteKind, SyntaxKind, type ObjectLiteralExpression, type SourceFile } from "ts-morph"

export interface UpdateAppConfigInput {
  mode: "none" | "static" | "proxy"
  staticDir?: string
  upstream?: string
}

export function updateAppConfigInProject(cwd: string, input: UpdateAppConfigInput): string {
  const configPath = resolve(cwd, "supatype.config.ts")
  if (!existsSync(configPath)) {
    throw new Error("supatype.config.ts not found. Run: supatype init")
  }
  const next = updateAppConfigAst(configPath, input)
  writeFileSync(configPath, next, "utf8")
  return configPath
}

function updateAppConfigAst(configPath: string, input: UpdateAppConfigInput): string {
  const project = new Project({
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
    manipulationSettings: {
      quoteKind: QuoteKind.Double,
    },
  })
  const srcText = readFileSync(configPath, "utf8")
  const sourceFile = project.createSourceFile(configPath, srcText, { overwrite: true })
  const rootObject = getRootConfigObject(sourceFile)

  const appProperty = rootObject.getProperty("app")

  if (appProperty === undefined) {
    rootObject.addPropertyAssignment({
      name: "app",
      initializer: renderAppInitializer(input),
    })
  } else if (Node.isPropertyAssignment(appProperty)) {
    const init = appProperty.getInitializer()
    if (init && Node.isObjectLiteralExpression(init)) {
      patchAppObject(init, input)
    } else {
      appProperty.setInitializer(renderAppInitializer(input))
    }
  } else {
    appProperty.remove()
    rootObject.addPropertyAssignment({
      name: "app",
      initializer: renderAppInitializer(input),
    })
  }

  return sourceFile.getFullText()
}

export interface UpdateServerConfigInput {
  domain: string
  tlsEmail: string
  provider?: "kong" | "none"
}

/**
 * Set `server.mode = "standalone"` plus `domain` and `tls` in supatype.config.ts,
 * enabling self-host HTTPS. Preserves other `server` keys (port, etc).
 */
export function updateServerConfigInProject(cwd: string, input: UpdateServerConfigInput): string {
  const configPath = resolve(cwd, "supatype.config.ts")
  if (!existsSync(configPath)) {
    throw new Error("supatype.config.ts not found. Run: supatype init")
  }
  const next = updateServerConfigAst(configPath, input)
  writeFileSync(configPath, next, "utf8")
  return configPath
}

function updateServerConfigAst(configPath: string, input: UpdateServerConfigInput): string {
  const project = new Project({
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
    manipulationSettings: {
      quoteKind: QuoteKind.Double,
    },
  })
  const srcText = readFileSync(configPath, "utf8")
  const sourceFile = project.createSourceFile(configPath, srcText, { overwrite: true })
  const rootObject = getRootConfigObject(sourceFile)

  const serverProperty = rootObject.getProperty("server")

  if (serverProperty === undefined) {
    rootObject.addPropertyAssignment({
      name: "server",
      initializer: renderServerInitializer(input),
    })
  } else if (Node.isPropertyAssignment(serverProperty)) {
    const init = serverProperty.getInitializer()
    if (init && Node.isObjectLiteralExpression(init)) {
      patchServerObject(init, input)
    } else {
      serverProperty.setInitializer(renderServerInitializer(input))
    }
  } else {
    serverProperty.remove()
    rootObject.addPropertyAssignment({
      name: "server",
      initializer: renderServerInitializer(input),
    })
  }

  return sourceFile.getFullText()
}

function renderServerInitializer(input: UpdateServerConfigInput): string {
  const provider = input.provider ?? "kong"
  return `{
    mode: "standalone",
    domain: "${input.domain}",
    tls: { email: "${input.tlsEmail}", provider: "${provider}" },
  }`
}

function patchServerObject(serverObj: ObjectLiteralExpression, input: UpdateServerConfigInput): void {
  upsertStringProperty(serverObj, "mode", "standalone")
  upsertStringProperty(serverObj, "domain", input.domain)
  const provider = input.provider ?? "kong"
  const tlsInitializer = `{ email: "${input.tlsEmail}", provider: "${provider}" }`
  const existing = serverObj.getProperty("tls")
  if (existing && Node.isPropertyAssignment(existing)) {
    existing.setInitializer(tlsInitializer)
  } else {
    if (existing) existing.remove()
    serverObj.addPropertyAssignment({ name: "tls", initializer: tlsInitializer })
  }
}

function getRootConfigObject(sourceFile: SourceFile): ObjectLiteralExpression {
  const exportAssignment = sourceFile.getFirstDescendantByKind(SyntaxKind.ExportAssignment)
  if (!exportAssignment) {
    throw new Error("Could not find default export in supatype.config.ts.")
  }
  const expr = exportAssignment.getExpression()
  if (Node.isObjectLiteralExpression(expr)) {
    return expr
  }
  if (Node.isCallExpression(expr)) {
    const [firstArg] = expr.getArguments()
    if (firstArg && Node.isObjectLiteralExpression(firstArg)) {
      return firstArg
    }
  }
  throw new Error(
    "supatype.config.ts must export an object literal or defineConfig({...}).",
  )
}

function renderAppInitializer(input: UpdateAppConfigInput): string {
  if (input.mode === "proxy") {
    return `{
      mode: "proxy",
      upstream: "${input.upstream ?? "http://localhost:3000"}",
    }`
  }
  if (input.mode === "static") {
    return `{
      mode: "static",
      static_dir: "${input.staticDir ?? "./dist"}",
    }`
  }
  return `{
    mode: "none",
  }`
}

function patchAppObject(appObj: ObjectLiteralExpression, input: UpdateAppConfigInput): void {
  upsertStringProperty(appObj, "mode", input.mode)

  if (input.mode === "proxy") {
    upsertStringProperty(appObj, "upstream", input.upstream ?? "http://localhost:3000")
    removePropertyIfPresent(appObj, "static_dir")
    return
  }

  if (input.mode === "static") {
    upsertStringProperty(appObj, "static_dir", input.staticDir ?? "./dist")
    removePropertyIfPresent(appObj, "upstream")
    return
  }

  removePropertyIfPresent(appObj, "upstream")
  removePropertyIfPresent(appObj, "static_dir")
}

function upsertStringProperty(obj: ObjectLiteralExpression, key: string, value: string): void {
  const existing = obj.getProperty(key)
  if (existing && Node.isPropertyAssignment(existing)) {
    existing.setInitializer(`"${value}"`)
    return
  }
  if (existing) existing.remove()
  obj.addPropertyAssignment({ name: key, initializer: `"${value}"` })
}

function removePropertyIfPresent(obj: ObjectLiteralExpression, key: string): void {
  const prop = obj.getProperty(key)
  if (prop) prop.remove()
}
