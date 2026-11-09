// The oldest Node the published package runs on, checked before anything else loads.
//
// bin/supatype.js imports this first, so it runs before the rest of the starter. Installed from
// npm, Node runs only the starter, which downloads the compiled program (with global `fetch`, which
// Node 16 lacks) and starts it. Below the floor that failed with a message about `fetch` or a
// missing built-in module; this says what to install instead. The syntax is kept to what any Node
// that can load an ES module parses, and the imports to none, so an old Node reaches this line.
//
// 0.9.1 release test (RB7): keep `engines.node` in package.json at this floor. A higher one makes
// npm quietly install an old release that declares none on the Nodes in between.

export const NODE_FLOOR = 18

/** The line to print when Node `version` (as process.versions.node gives it) is too old, or null. */
export function nodeVersionRefusal(version) {
  const major = parseInt(String(version).split(".")[0], 10)
  if (major >= NODE_FLOOR) return null
  return (
    "Supatype's CLI needs Node.js " + NODE_FLOOR + " or later; this is Node.js " + version + ". " +
    "Install a newer Node from https://nodejs.org"
  )
}

const refusal = nodeVersionRefusal(process.versions.node)
if (refusal !== null) {
  console.error(refusal)
  process.exit(1)
}
