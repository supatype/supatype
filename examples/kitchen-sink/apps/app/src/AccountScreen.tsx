import React, { useState } from "react"
import { supatype } from "./client.js"
import { Avatar, Button, Card, Note, PageHeader, ProvesNote, Row, Stack } from "./components/ui.js"

const BUCKET = "speaker-headshots"

type Uploaded = { path: string; original: string; transformed: string }

/**
 * Your account, and the one place this app writes a file.
 *
 * This used to be a tab called "Media" whose entire content was a file input and two images
 * captioned "as uploaded" and "160×160 webp, transformed on read". The storage path it exercises
 * is worth keeping — nothing else in this repository uploads at runtime, so before it the whole
 * path was typechecked and never run — but an attendee has no reason to visit a screen called
 * Media. Changing a profile picture is a reason.
 *
 * The transform is the half worth watching. `getPublicUrl` with no options returns the bytes that
 * were uploaded; with `transform` it returns a resized, re-encoded derivative, and the two URLs
 * differing is what proves the transformer is wired rather than a CDN echoing the original.
 */
export function AccountScreen({ email }: { email: string }): React.ReactElement {
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
    const path = `avatars/${Date.now()}-${file.name}`
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
    <>
      <PageHeader title="Account" subtitle={email} />

      <ProvesNote>
        <p>
          Uploads go to <code>speaker-headshots</code>, a public bucket whose <code>create</code>{" "}
          rule is <code>BucketLoggedIn</code>. Signed out, the same call is refused by the server
          rather than hidden by the interface.
        </p>
        <p>
          The same object is then read back twice: once as uploaded, once resized and re-encoded on
          read. Two different URLs for one stored object is what proves the transform is real.
        </p>
        <p>
          Compare <strong>My ticket</strong>, where the bucket is private and the URL has to be
          signed.
        </p>
      </ProvesNote>

      <Card title="Profile picture">
        <Stack gap={16}>
          <Row gap={16} wrap align="top">
            <Avatar name={email} src={uploaded?.transformed ?? null} size={72} />
            <Stack gap={8}>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={busy}
                aria-label="Choose a picture"
                onChange={(e) => void onPick(e)}
              />
              <span className="ks-faint ks-small">PNG, JPEG or WebP, up to 5MB.</span>
            </Stack>
          </Row>

          {error !== null && <Note tone="error">{error}</Note>}

          {uploaded !== null && (
            <Stack gap={12}>
              <Row gap={20} wrap align="top">
                <Stack gap={6}>
                  <img
                    src={uploaded.original}
                    alt="the bytes that were uploaded"
                    style={{ maxWidth: 140, borderRadius: 8, display: "block" }}
                  />
                  <span className="ks-faint ks-small">as uploaded</span>
                </Stack>
                <Stack gap={6}>
                  <img
                    src={uploaded.transformed}
                    alt="resized and re-encoded on read"
                    style={{ maxWidth: 140, borderRadius: 8, display: "block" }}
                  />
                  <span className="ks-faint ks-small">160×160 webp, transformed on read</span>
                </Stack>
              </Row>
              <Row gap={10} wrap>
                <Button size="sm" disabled={busy} onClick={() => void onRemove()}>
                  Remove it again
                </Button>
                <span className="ks-faint ks-small ks-mono ks-truncate">{uploaded.path}</span>
              </Row>
            </Stack>
          )}
        </Stack>
      </Card>
    </>
  )
}
