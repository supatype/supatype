const path = require("node:path")
const fs = require("node:fs")
const { getDefaultConfig } = require("expo/metro-config")

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, "../..")
const packagesRoot = path.join(workspaceRoot, "packages")

const config = getDefaultConfig(projectRoot)

config.watchFolders = [workspaceRoot]
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
]

function resolveSupatypeEntrypoint(moduleName) {
  const segments = moduleName.split("/")
  if (segments.length < 2 || segments[0] !== "@supatype") return null
  const dirName = segments[1]
  const pkgRoot = path.join(packagesRoot, dirName)
  const pkgJsonPath = path.join(pkgRoot, "package.json")
  if (!fs.existsSync(pkgJsonPath)) return null
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"))
  const subpath = segments.length > 2 ? `./${segments.slice(2).join("/")}` : "."
  const exp = pkg.exports?.[subpath] ?? (subpath === "." ? pkg.exports?.["."] : undefined)
  let rel
  if (typeof exp === "string") rel = exp
  else if (exp && typeof exp === "object") rel = exp.import ?? exp.default ?? exp.require
  else if (subpath === ".") rel = pkg.main
  if (typeof rel !== "string") return null
  const filePath = path.resolve(pkgRoot, rel)
  return fs.existsSync(filePath) ? filePath : null
}

const defaultResolveRequest = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith("@supatype/")) {
    const filePath = resolveSupatypeEntrypoint(moduleName)
    if (filePath) {
      return { filePath, type: "sourceFile" }
    }
  }
  if (typeof defaultResolveRequest === "function") {
    return defaultResolveRequest(context, moduleName, platform)
  }
  return context.resolveRequest(context, moduleName, platform)
}

module.exports = config
