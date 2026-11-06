// A `docker` for tests: logs each call's arguments to FAKE_DOCKER_LOG, one line each, and answers as
// a running Docker with no containers for any project. Every call succeeds and starts nothing.
const { appendFileSync } = require("node:fs")
const args = process.argv.slice(2)
if (process.env.FAKE_DOCKER_LOG) appendFileSync(process.env.FAKE_DOCKER_LOG, `${args.join(" ")}\n`)
if (args[0] === "version") process.stdout.write("28.0.1\n")
else if (args[0] === "info") process.stdout.write("Server Version: 28.0.1\n")
else if (args[0] === "inspect") process.exit(1)
