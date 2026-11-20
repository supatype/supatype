import { createCipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

/** What the browser sends the control plane when the user approves: the CLI's own login URL, parsed. */
export interface ApprovedLogin {
  sessionId: string
  tokenName: string
  publicKey: string
}

interface StoredLogin {
  ciphertext: string
  nonce: string
  serverPublicKey: string
  deviceCode: string
}

/**
 * The control plane's side of the browser login contract: a PAT encrypted to the CLI's public key
 * (ECDH P-256, HKDF-SHA256 with an empty salt and the info "supatype-cli-login", AES-256-GCM with
 * the tag after the ciphertext), a device code, and the one-time poll endpoint. Written from the
 * contract, not from the CLI's code, so a decrypt that passes here was proven against a real encrypt.
 */
export class FakeCliLoginServer {
  readonly pat = `spt_${randomBytes(20).toString("hex")}`
  readonly deviceCode = "ABCD2345"
  /** The device codes the CLI sent, in order, as they arrived in the query string, untouched; like the real server, it ignores dashes, spaces and case when comparing. */
  readonly codesTried: string[] = []
  /** The Authorization headers `/auth/me` saw. */
  readonly meAuthorization: string[] = []
  email = "dev@example.test"
  /** What `/api/v1/cli/login/config` answers with; a status other than 200 makes it fail. */
  accountsUrl: unknown = "http://accounts.example.test"
  configStatus = 200
  /** How many times the config was asked for. */
  configAsks = 0
  private readonly logins = new Map<string, StoredLogin>()
  private server: Server | undefined

  /** Approve a login as the accounts page does: make the PAT and encrypt it to `login.publicKey`. */
  approve(login: ApprovedLogin): void {
    const serverKeys = createECDH("prime256v1")
    serverKeys.generateKeys()
    const shared = serverKeys.computeSecret(Buffer.from(login.publicKey, "hex"))
    const key = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), "supatype-cli-login", 32))
    const nonce = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", key, nonce)
    const sealed = Buffer.concat([cipher.update(this.pat, "utf8"), cipher.final(), cipher.getAuthTag()])
    this.logins.set(login.sessionId, {
      ciphertext: sealed.toString("hex"),
      nonce: nonce.toString("hex"),
      serverPublicKey: serverKeys.getPublicKey("hex"),
      deviceCode: this.deviceCode,
    })
  }

  /** Forget every login, as the 10 minute expiry does. */
  expireAll(): void {
    this.logins.clear()
  }

  async listen(): Promise<string> {
    const server = createServer((req, res) =>
      this.handle(req.url ?? "", req.headers.authorization, (status, body) => {
        res.writeHead(status, { "Content-Type": "application/json" })
        res.end(JSON.stringify(body))
      }),
    )
    this.server = server
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address() as AddressInfo
    return `http://127.0.0.1:${address.port}`
  }

  async close(): Promise<void> {
    const server = this.server
    if (server === undefined) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private handle(rawUrl: string, authorization: string | undefined, reply: (status: number, body: unknown) => void): void {
    const url = new URL(rawUrl, "http://fake.test")
    if (url.pathname === "/auth/me") {
      this.meAuthorization.push(authorization ?? "")
      if (authorization !== `Bearer ${this.pat}`) return reply(401, { error: "invalid_token" })
      return reply(200, { user: { id: "u1", email: this.email }, orgs: [] })
    }
    if (url.pathname === "/api/v1/cli/login/config") {
      this.configAsks++
      if (this.configStatus !== 200) return reply(this.configStatus, { error: "nope" })
      return reply(200, { accounts_url: this.accountsUrl })
    }
    const match = /^\/api\/v1\/cli\/login\/([^/]+)$/.exec(url.pathname)
    if (match?.[1] === undefined) return reply(404, { error: "not_found" })
    const code = url.searchParams.get("device_code") ?? ""
    this.codesTried.push(code)
    const stored = this.logins.get(match[1])
    if (stored === undefined || code.replace(/[\s-]/g, "").toUpperCase() !== stored.deviceCode) {
      return reply(404, { error: "not_found" })
    }
    this.logins.delete(match[1])
    reply(200, { access_token: stored.ciphertext, nonce: stored.nonce, public_key: stored.serverPublicKey })
  }
}

/** The login URL the CLI printed in `output`, parsed into what the browser would send. */
export function loginUrlFrom(output: string): { url: URL; login: ApprovedLogin } {
  const found = /https?:\/\/\S+\/cli\/login\?\S+/.exec(output)
  if (found === null) throw new Error(`no login URL in the output:\n${output}`)
  const url = new URL(found[0])
  const get = (name: string): string => url.searchParams.get(name) ?? ""
  return { url, login: { sessionId: get("session_id"), tokenName: get("token_name"), publicKey: get("public_key") } }
}
