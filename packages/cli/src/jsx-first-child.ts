/**
 * Lines added as the first children of one element in a JSX file init does not own: a Next.js root
 * layout's `<body>`, an Expo Router `+html.tsx`'s `<head>`. Read as text, since init never runs the
 * app's code, and only where that cannot go wrong; otherwise the caller prints the lines instead.
 */

/**
 * `edit` applied to `source` with `\n` line ends, its result given back the line ends `source` had:
 * a file saved with `\r\n` keeps them, and the added lines get them too.
 */
export function withSourceLineEnds(source: string, edit: (text: string) => string | undefined): string | undefined {
  const eol = source.includes("\r\n") ? "\r\n" : "\n"
  return edit(source.replace(/\r\n/g, "\n"))?.replace(/\n/g, eol)
}

/**
 * `source` with `lines` as the first children of its one `<tag>` element, indented as its children
 * are, in the line ends `source` has. Undefined when that cannot be done without guessing: no such
 * element or more than one, a self-closing one, or one whose attributes hold a `>`. A tag named in a
 * comment does not count: Expo's own `+html.tsx` says "Add any additional <head> elements" in one.
 */
export function withFirstChildren(source: string, tag: "body" | "head", lines: readonly string[]): string | undefined {
  return withSourceLineEnds(source, (text) => {
    const opens = [...withoutComments(text).matchAll(new RegExp(`<${tag}\\b[^>]*>`, "g"))]
    const open = opens[0]
    if (opens.length !== 1 || open === undefined || open[0].endsWith("/>") || !balancedBraces(open[0])) return undefined
    const end = open.index + open[0].length
    const indent = childIndent(text, open.index, end)
    return text.slice(0, end) + lines.map((line) => `\n${indent}${line}`).join("") + text.slice(end)
  })
}

/**
 * `text` with its block comments (JSX comments among them) and whole-line `//` comments blanked to
 * spaces, so every other character keeps its index.
 */
function withoutComments(text: string): string {
  const blank = (comment: string): string => comment.replace(/[^\n]/g, " ")
  return text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/^[ \t]*\/\/[^\n]*/gm, blank)
}

/** Whether every `{` in a tag's attributes is closed in it, so its `>` really ends the tag. */
function balancedBraces(tag: string): boolean {
  let depth = 0
  for (const ch of tag) depth += ch === "{" ? 1 : ch === "}" ? -1 : 0
  return depth === 0
}

/** The indentation of the line after the tag when deeper than its own, else its own plus two. */
function childIndent(text: string, tagStart: number, tagEnd: number): string {
  const lineStart = text.lastIndexOf("\n", tagStart) + 1
  const own = /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? ""
  const next = /^\n([ \t]*)\S/.exec(text.slice(tagEnd))?.[1]
  return next !== undefined && next.length > own.length ? next : `${own}  `
}
