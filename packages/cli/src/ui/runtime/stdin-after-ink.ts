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

  stdin.resume()
  process.stdout.write("\n")
}
