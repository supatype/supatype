#!/usr/bin/env node
import("../dist/cli.js").then((m) => m.run()).catch((e) => {
  console.error(e?.message ?? e)
  process.exit(1)
})
