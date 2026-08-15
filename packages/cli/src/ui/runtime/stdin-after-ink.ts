/** Restore stdin after Ink unmount so one-shot commands (init, link) can exit cleanly. */
export function restoreStdinAfterInk(): void {
  if (!process.stdin.isTTY) return

  const stdin = process.stdin as NodeJS.ReadStream & {
    isRaw?: boolean
    setRawMode?(mode: boolean): void
  }

  try {
    if (stdin.isRaw) stdin.setRawMode?.(false)
  } catch {
    // ignore — stdin may already be restored
  }

  // Pause so one-shot Ink flows (cache list, keys, …) can exit; resume() would keep the
  // process alive waiting for stdin on Windows Git Bash / MINGW64.
  stdin.pause()
  process.stdout.write("\n")
}
