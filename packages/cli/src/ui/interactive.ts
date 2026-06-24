/** True when stdin/stdout are TTYs — interactive prompts and spinners are allowed. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}
