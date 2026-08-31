/**
 * Point a project's config at an SMTP catcher, so a test can read the mail the
 * server actually sends.
 *
 *   node point-email-at-smtp.mjs <config-path> <smtp-port> [host]
 *
 * The server runs in a container, so the default host is the Docker host gateway
 * rather than localhost. The config files here are CRLF, so the inserted block
 * takes the line ending of the file it goes into rather than assuming one.
 */
import { readFileSync, writeFileSync } from "node:fs"

const [configPath, smtpPort, host = "host.docker.internal"] = process.argv.slice(2)
if (!configPath || !smtpPort) {
  console.error("usage: point-email-at-smtp.mjs <config-path> <smtp-port> [host]")
  process.exit(1)
}

let text = readFileSync(configPath, "utf8")
const eol = text.includes("\r\n") ? "\r\n" : "\n"

const block = [
  "  email: {",
  '    provider: "smtp",',
  "    smtp: {",
  `      host: "${host}",`,
  `      port: ${smtpPort},`,
  '      admin_email: "e2e@example.com",',
  '      sender_name: "Supatype e2e",',
  "    },",
  "  },",
  "",
].join(eol)

// Drop an existing email block, whatever it says, then insert after `app:`.
text = text.replace(/^[ \t]*email:[ \t]*\{[\s\S]*?\r?\n[ \t]*\},[ \t]*\r?\n/m, "")

const afterApp = /([ \t]*app:[ \t]*\{[^}]*\},[ \t]*\r?\n)/
if (!afterApp.test(text)) {
  console.error("could not find an `app:` block to insert after")
  process.exit(1)
}
text = text.replace(afterApp, (_m, appBlock) => appBlock + block)

if (!text.includes('provider: "smtp"')) {
  console.error("the smtp block was not inserted")
  process.exit(1)
}

writeFileSync(configPath, text)
console.log(`    email.provider = smtp, ${host}:${smtpPort}`)
