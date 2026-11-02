/**
 * How the service reads an object name and a list prefix, the same rule the server's own object
 * store follows. A name is a path of parts: one leading "/" a client may write before it is
 * stripped, and a part that is empty, "." or ".." is not a name of its own. Stored as written,
 * "x/../a", "./a" and "x//a" reached the objects "a" and "x/a" once a path was cleaned on the way to
 * the bytes, so they are refused, never stored or served.
 */

/** Whether `part` is path structure rather than a name: empty, "." or "..". */
const isStepPart = (part: string): boolean => part === "" || part === "." || part === ".."

/** `sent` with the one leading "/" a name or prefix may carry stripped, and only that one. */
const withoutLeadingSlash = (sent: string): string => (sent.startsWith("/") ? sent.slice(1) : sent)

/** `sent` as an object name: its one leading "/" stripped, or null when a part is empty, "." or "..". */
export function objectName(sent: string): string | null {
  const name = withoutLeadingSlash(sent)
  return name.split("/").some(isStepPart) ? null : name
}

/** The refusal of a name or prefix, quoting it as the client sent it. */
export function refusedName(sent: string): string {
  return `${JSON.stringify(sent)}: invalid object path`
}

/**
 * The folder a list prefix names: "" for the bucket root, else its path ending in "/", or null
 * when it is refused. One leading "/" and the one trailing "/" a folder is written with are
 * stripped; an empty part left is refused ("//", "a//", "a//b"). A "." or ".." part is cleaned, so
 * "a/.." is the folder holding a, while one that climbs out of the bucket is refused.
 */
export function folderOf(prefix: string): string | null {
  const name = withoutLeadingSlash(prefix)
  const folder = name.endsWith("/") ? name.slice(0, -1) : name
  if (name !== "" && folder.split("/").includes("")) return null
  const parts: string[] = []
  for (const part of folder.split("/")) {
    if (part === ".." && parts.pop() === undefined) return null
    if (!isStepPart(part)) parts.push(part)
  }
  return parts.length === 0 ? "" : `${parts.join("/")}/`
}
