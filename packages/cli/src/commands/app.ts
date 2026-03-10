import type { Command } from "commander"
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { APP_COMPOSE_MARKER, KONG_APP_MARKER } from "./init.js"

export function registerApp(program: Command): void {
  const appCmd = program
    .command("app")
    .description("Manage your application container in the Supatype stack")

  appCmd
    .command("add")
    .description("Add your application to the docker-compose stack at /")
    .option("--dockerfile <path>", "Path to your Dockerfile", "./Dockerfile")
    .option("--port <port>", "Port your app listens on", "3000")
    .action((opts: { dockerfile: string; port: string }) => {
      addApp(process.cwd(), opts.dockerfile, opts.port)
    })

  appCmd
    .command("remove")
    .description("Remove your application from the docker-compose stack")
    .action(() => {
      removeApp(process.cwd())
    })
}

// ─── Implementation ───────────────────────────────────────────────────────────

function addApp(cwd: string, dockerfile: string, port: string): void {
  const composePath = resolve(cwd, "docker-compose.yml")
  if (!existsSync(composePath)) {
    console.error("docker-compose.yml not found. Run: supatype init")
    process.exit(1)
  }

  let compose = readFileSync(composePath, "utf8")
  if (!compose.includes(APP_COMPOSE_MARKER)) {
    console.error("App service slot not found in docker-compose.yml. Is this a supatype project?")
    process.exit(1)
  }

  if (isAppActive(compose)) {
    console.error("App service is already configured. Run: supatype app remove first.")
    process.exit(1)
  }

  compose = uncommentServiceBlock(compose, APP_COMPOSE_MARKER, { dockerfile, port })
  writeFileSync(composePath, compose, "utf8")
  console.log("  updated  docker-compose.yml")

  const kongPath = resolve(cwd, ".supatype/kong.yml")
  if (existsSync(kongPath)) {
    let kong = readFileSync(kongPath, "utf8")
    if (kong.includes(KONG_APP_MARKER)) {
      kong = uncommentKongBlock(kong, KONG_APP_MARKER, port)
      writeFileSync(kongPath, kong, "utf8")
      console.log("  updated  .supatype/kong.yml")
    }
  }

  console.log(`\nApp service added (port ${port}). Your app will be available at http://localhost:8000/\n`)
  console.log("Run: supatype dev")
}

function removeApp(cwd: string): void {
  const composePath = resolve(cwd, "docker-compose.yml")
  if (!existsSync(composePath)) {
    console.error("docker-compose.yml not found.")
    process.exit(1)
  }

  let compose = readFileSync(composePath, "utf8")
  if (!isAppActive(compose)) {
    console.error("No active app service found.")
    process.exit(1)
  }

  compose = recommentServiceBlock(compose, APP_COMPOSE_MARKER)
  writeFileSync(composePath, compose, "utf8")
  console.log("  updated  docker-compose.yml")

  const kongPath = resolve(cwd, ".supatype/kong.yml")
  if (existsSync(kongPath)) {
    let kong = readFileSync(kongPath, "utf8")
    if (!kong.includes(KONG_APP_MARKER)) {
      // Active route — re-comment it
      kong = recommentKongBlock(kong)
    }
    writeFileSync(kongPath, kong, "utf8")
    console.log("  updated  .supatype/kong.yml")
  }

  console.log("\nApp service removed.\n")
}

// ─── Block manipulation helpers ───────────────────────────────────────────────

/** Returns true if the docker-compose has an active (uncommented) app: service. */
function isAppActive(compose: string): boolean {
  return /^  app:/m.test(compose)
}

/**
 * Finds the commented app service block after the marker line and uncomments it,
 * substituting the dockerfile path and port.
 */
function uncommentServiceBlock(
  compose: string,
  marker: string,
  opts: { dockerfile: string; port: string },
): string {
  const lines = compose.split("\n")
  const markerIdx = lines.findIndex((l) => l === marker)
  if (markerIdx === -1) return compose

  const result: string[] = []
  let i = 0

  while (i < lines.length) {
    if (i === markerIdx) {
      // Skip the marker line itself, then uncomment the block
      i++
      while (i < lines.length) {
        const line = lines[i]!
        // End of block: empty line followed by a non-commented service-level line
        if (line === "" && i + 1 < lines.length && !/^  #/.test(lines[i + 1]!)) {
          result.push(line)
          i++
          break
        }
        if (/^  # /.test(line)) {
          // Uncomment: replace "  # " prefix with "  "
          let uncommented = line.replace(/^  # /, "  ")
          // Substitute placeholders
          uncommented = uncommented.replace("./Dockerfile", opts.dockerfile)
          uncommented = uncommented.replace(/- "3000:3000"/, `- "${opts.port}:${opts.port}"`)
          result.push(uncommented)
        } else if (line === "" || /^  #─/.test(line)) {
          // Skip remaining marker-style comment lines
        } else {
          result.push(line)
        }
        i++
      }
    } else {
      result.push(lines[i]!)
      i++
    }
  }

  return result.join("\n")
}

/**
 * Finds the active app: service block and re-comments it, restoring the marker.
 */
function recommentServiceBlock(compose: string, marker: string): string {
  const lines = compose.split("\n")
  const appIdx = lines.findIndex((l) => l === "  app:")
  if (appIdx === -1) return compose

  const result: string[] = []
  let i = 0

  while (i < lines.length) {
    if (i === appIdx) {
      result.push(marker)
      // Re-comment lines until we hit an empty line or the volumes: section
      while (i < lines.length) {
        const line = lines[i]!
        if (line === "" || /^volumes:/.test(line) || /^  \w/.test(line)) {
          result.push(line)
          i++
          break
        }
        // Re-comment: "  X..." → "  # X..."
        result.push(line.replace(/^  /, "  # "))
        i++
      }
    } else {
      result.push(lines[i]!)
      i++
    }
  }

  return result.join("\n")
}

/**
 * Uncomments the Kong app route block after the marker.
 */
function uncommentKongBlock(kong: string, marker: string, port: string): string {
  const lines = kong.split("\n")
  const markerIdx = lines.findIndex((l) => l === marker)
  if (markerIdx === -1) return kong

  const result: string[] = []
  let i = 0

  while (i < lines.length) {
    if (i === markerIdx) {
      i++ // skip marker
      while (i < lines.length) {
        const line = lines[i]!
        if (line === "" && (i + 1 >= lines.length || !/^  #/.test(lines[i + 1]!))) {
          result.push(line)
          i++
          break
        }
        if (/^  # /.test(line)) {
          let uncommented = line.replace(/^  # /, "  ")
          uncommented = uncommented.replace(":3000", `:${port}`)
          result.push(uncommented)
        } else {
          result.push(line)
        }
        i++
      }
    } else {
      result.push(lines[i]!)
      i++
    }
  }

  return result.join("\n")
}

/**
 * Finds the active Kong app route and re-comments it, restoring the marker.
 */
function recommentKongBlock(kong: string): string {
  const lines = kong.split("\n")
  // Find "  - name: app" (the active route)
  const appIdx = lines.findIndex((l) => /^  - name: app$/.test(l))
  if (appIdx === -1) return kong

  const result: string[] = []
  let i = 0

  while (i < lines.length) {
    if (i === appIdx) {
      result.push(KONG_APP_MARKER)
      while (i < lines.length) {
        const line = lines[i]!
        if (line === "" || (i > appIdx && /^  - /.test(line))) {
          result.push(line)
          i++
          break
        }
        result.push(line.replace(/^  /, "  # "))
        i++
      }
    } else {
      result.push(lines[i]!)
      i++
    }
  }

  return result.join("\n")
}
