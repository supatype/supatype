import type { NextConfig } from "next"

// Served through the deployment rather than beside it: `app.mode: "proxy"` puts this at / on the
// same origin as the API, so a reader reaches the site and Studio reaches the API through one
// gateway, and a preview link needs no origin of its own.
const config: NextConfig = {}

export default config
