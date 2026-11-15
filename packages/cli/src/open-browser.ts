import { spawn } from "node:child_process"

/** The program and arguments that hand `url` to the platform's default browser. */
function openerFor(url: string, platform: NodeJS.Platform): { file: string; args: string[] } {
  if (platform === "win32") return { file: "rundll32", args: ["url.dll,FileProtocolHandler", url] }
  if (platform === "darwin") return { file: "open", args: [url] }
  return { file: "xdg-open", args: [url] }
}

/**
 * Open `url` in the default browser. Resolves true once the opener has started, false when there is
 * none (a headless box has no `xdg-open`), so the caller can say the URL has to be opened by hand.
 * The URL is never put through a shell: it carries `&`, which `cmd` would read as a second command.
 */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const { file, args } = openerFor(url, platform)
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: "ignore", detached: true })
    child.once("error", () => resolve(false))
    child.once("spawn", () => {
      child.unref()
      resolve(true)
    })
  })
}
