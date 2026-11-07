/**
 * The SAML service provider's signing certificate, as `supatype sso info` prints it.
 *
 * The server builds the certificate from its key when it starts and publishes it in its SP metadata;
 * nothing in the project stores it. So it is read from the metadata the server serves: the current
 * certificate first and, while a rotation is in progress, the next one after it.
 */
import { X509Certificate } from "node:crypto"

/** One certificate from the SP metadata. */
export interface SpCertificate {
  pem: string
  /** SHA-256 fingerprint, colon-separated hex, the form identity providers show. */
  fingerprint256: string
}

const METADATA_TIMEOUT_MS = 10_000

/**
 * The certificates in SP metadata, in order and once each (a key is listed for signing and encryption).
 * The element may carry a namespace prefix (`ds:X509Certificate`) or attributes: the server writes
 * `<X509Certificate xmlns="...">`, which a pattern wanting `>` straight after the name missed (issue 56).
 */
export function spCertificates(metadataXml: string): SpCertificate[] {
  const bodies = [...metadataXml.matchAll(/<(?:[\w-]+:)?X509Certificate\b[^>]*>([^<]+)<\/(?:[\w-]+:)?X509Certificate>/g)]
    .map((match) => (match[1] ?? "").replace(/\s+/g, ""))
    .filter((body, index, all) => body !== "" && all.indexOf(body) === index)
  return bodies.map((body) => {
    const cert = new X509Certificate(Buffer.from(body, "base64"))
    return { pem: cert.toString().trim(), fingerprint256: cert.fingerprint256 }
  })
}

/** The certificates the server at `metadataUrl` publishes. Throws with the reason when it cannot be read. */
export async function fetchSpCertificates(metadataUrl: string): Promise<SpCertificate[]> {
  const res = await fetch(metadataUrl, { signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`it answered ${res.status}`)
  const certificates = spCertificates(await res.text())
  if (certificates.length === 0) throw new Error("it lists no certificate")
  return certificates
}
