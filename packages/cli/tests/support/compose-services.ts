/** The services of a rendered compose file, each by name with the lines of its block, in file order. */
export function composeServiceBlocks(compose: string): Map<string, string[]> {
  const lines = compose.split("\n")
  const found = new Map<string, string[]>()
  let current: string[] | null = null
  for (const line of lines.slice(lines.indexOf("services:") + 1)) {
    if (/^\S/.test(line)) break
    const name = /^ {2}([a-z][a-z0-9-]*):$/.exec(line)?.[1]
    if (name !== undefined) {
      current = []
      found.set(name, current)
    } else current?.push(line)
  }
  return found
}
