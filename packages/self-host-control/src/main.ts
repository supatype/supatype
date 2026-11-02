/**
 * The control plane's process entry: it always starts the server. The image and `npm start` run
 * this file (package.json `supatype.entry`); server.ts only exports. server.ts used to start the
 * server only when `process.argv[1]` was itself, which a bundle or a renamed copy is not.
 */
import { CONTROL_PLANE_SECRET_ENV, controlPlaneSecretFromEnv } from "./auth.js"
import { createControlPlaneServer } from "./server.js"

const port = parseInt(process.env["PORT"] ?? "8080", 10)
// Refuses to start rather than starting into a state where it answers nobody: a stack missing the
// variable is a setup mistake, and an exit says so where a wall of 401s would not.
const secret = controlPlaneSecretFromEnv()
if (secret === "") {
  console.error(`[control-plane] ${CONTROL_PLANE_SECRET_ENV} is not set; refusing to start`)
  process.exit(1)
}
createControlPlaneServer(secret).listen(port, "0.0.0.0", () => {
  console.log(`[control-plane] listening on :${port}`)
})
