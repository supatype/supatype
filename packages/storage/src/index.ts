import { createServer } from "./server.js"

const PORT = parseInt(process.env["PORT"] ?? "5000", 10)
const HOST = process.env["HOST"] ?? "0.0.0.0"

const server = createServer()

server.listen(PORT, HOST, () => {
  console.log(`supatype-storage listening on ${HOST}:${PORT}`)
})
