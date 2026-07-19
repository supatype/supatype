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

// Force a single React/RN copy from the Expo app (SDK 54 → RN 0.81.5).
// Without this, workspace peer installs (e.g. react-native@0.86) can win
// when Metro resolves from @supatype/react-native-auth's package tree.
const singletonModules = ["react", "react-dom", "react-native", "react-native-web"]
config.resolver.extraNodeModules = Object.fromEntries(
  singletonModules.map((name) => [
    name,
    path.resolve(projectRoot, "node_modules", name),
  ]),
)

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

function resolveProjectModule(moduleName) {
  const base = moduleName.split("/")[0]?.startsWith("@")
    ? moduleName.split("/").slice(0, 2).join("/")
    : moduleName.split("/")[0]
  if (!base || !singletonModules.includes(base)) return null
  const root = path.resolve(projectRoot, "node_modules", base)
  if (!fs.existsSync(root)) return null
  try {
    return {
      filePath: require.resolve(moduleName, { paths: [projectRoot] }),
      type: "sourceFile",
    }
  } catch {
    return null
  }
}

const defaultResolveRequest = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith("@supatype/")) {
    const filePath = resolveSupatypeEntrypoint(moduleName)
    if (filePath) {
      return { filePath, type: "sourceFile" }
    }
  }
  const pinned = resolveProjectModule(moduleName)
  if (pinned) return pinned
  if (typeof defaultResolveRequest === "function") {
    return defaultResolveRequest(context, moduleName, platform)
  }
  return context.resolveRequest(context, moduleName, platform)
}

module.exports = config
