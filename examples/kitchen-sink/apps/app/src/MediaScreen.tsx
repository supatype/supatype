import React, { useState } from "react"
import { supatype } from "./client.js"

const BUCKET = "speaker-headshots"

type Uploaded = { path: string; original: string; transformed: string }

/**
 * Storage, end to end: upload, then read the same object back two ways.
 *
 * Nothing in this repository exercised the storage *runtime* before this screen. `blog` declares
 * buckets in its schema and never uploads, so the whole path — a signed key accepted by the storage
 * API, a bucket policy admitting the write, transformation on read — was typechecked and never run.
 *
 * The transform is the half worth watching. `getPublicUrl` with no options returns the bytes that
 * were uploaded; with `transform` it returns a resized, re-encoded derivative, and the two URLs
 * differing is what proves the transformer is wired rather than the CDN echoing the original.
 */
export function MediaScreen(): React.ReactElement {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uploaded, setUploaded] = useState<Uploaded | null>(null)

  async function onPick(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0]
    if (!file) return

    setBusy(true)
    setError(null)

    // Namespaced by nothing clever: the bucket's `create` rule is `BucketLoggedIn`, so the server
    // decides who may write here. A path scheme is not an access control and this example should
    // not imply it is.
    const path = `uploads/${Date.now()}-${file.name}`
    const bucket = supatype.storage.from(BUCKET)

    const { error: uploadError } = await bucket.upload(path, file, { upsert: true })
    if (uploadError) {
      setError(uploadError.message)
      setBusy(false)
      return
    }

    setUploaded({
      path,
      original: bucket.getPublicUrl(path).data.publicUrl,
      transformed: bucket.getPublicUrl(path, {
        transform: { width: 160, height: 160, resize: "cover", format: "webp", quality: 80 },
      }).data.publicUrl,
    })
    setBusy(false)
  }

  async function onRemove(): Promise<void> {
    if (!uploaded) return
    setBusy(true)
    const { error: removeError } = await supatype.storage.from(BUCKET).remove([uploaded.path])
    if (removeError) setError(removeError.message)
    else setUploaded(null)
    setBusy(false)
  }

  return (
    <section>
      <p className="ks-muted">
        Uploads to <code>{BUCKET}</code>, a public bucket whose <code>create</code> rule is
        <code> BucketLoggedIn</code>. Signed out, the same call is refused by the server rather than
        hidden by the UI.
      </p>

      <input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={(e) => void onPick(e)} />

      {error !== null && <p className="ks-error">{error}</p>}

      {uploaded !== null && (
        <div className="ks-card">
          <h3>{uploaded.path}</h3>
          <div className="ks-row ks-row--media">
            <figure>
              <img src={uploaded.original} alt="the bytes that were uploaded" />
              <figcaption className="ks-muted">as uploaded</figcaption>
            </figure>
            <figure>
              <img src={uploaded.transformed} alt="resized and re-encoded on read" />
              <figcaption className="ks-muted">160×160 webp, transformed on read</figcaption>
            </figure>
          </div>
          <button className="ks-ghost" disabled={busy} onClick={() => void onRemove()}>
            Delete it again
          </button>
        </div>
      )}
    </section>
  )
}
