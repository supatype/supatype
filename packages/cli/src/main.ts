/**
 * Entry point for the standalone binary.
 *
 * `bin/supatype.js` stays the npm entry: it loads the CLI with a dynamic import, which Bun
 * cannot follow when compiling. Given `import("../dist/cli.js")` it emits a binary that
 * bundles one module and then fails at runtime with
 * `Cannot find module '../dist/cli.js' from '/$bunfs/root/supatype'`. The import below is
 * static, so the whole graph is embedded.
 */
import { run } from "./cli.js"
import { reportCliFatal } from "./ui/fatal.js"

// reportCliFatal rather than console.error: it is what run() already uses for a failed
// command, and it prints a stack under SUPATYPE_DEBUG=1. Open-coding the message here would
// make a crash report from a curl | bash user less useful than one from an npm user. This
// only fires for a throw during command registration, since run() catches everything after.
run().catch((err: unknown) => {
  reportCliFatal(err)
  process.exit(1)
})
