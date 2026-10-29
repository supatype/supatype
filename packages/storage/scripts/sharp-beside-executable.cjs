// The packaged storage service takes sharp from the node_modules directory beside its executable.
//
// sharp is a native addon that loads libvips from files next to it, which a single-file executable
// cannot hold, so the release archive carries sharp and its prebuilt libvips for its platform as
// ordinary files and the bundle loads them from there (build-release-archive.mjs aliases "sharp"
// to this file). Only the packaged service uses it; `node dist/index.js` imports sharp as usual.
const { dirname, join } = require("node:path")

module.exports = require(join(dirname(process.execPath), "node_modules", "sharp"))
