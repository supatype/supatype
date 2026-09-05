import React, { useState } from "react"
import { Button, Input, Select } from "./ui.js"
import { usePreviewLinks, type PreviewScope } from "../hooks/usePreviewLinks.js"

interface SharePreviewProps {
  /** The model's table name, which is what the claim names. */
  modelTable: string
  recordId: string
  /** Where a preview of this record lives, if the project told Studio. */
  previewUrl?: string | undefined
}

const TTL_CHOICES: Array<{ label: string; seconds: number }> = [
  { label: "15 minutes", seconds: 900 },
  { label: "1 hour", seconds: 3600 },
  { label: "1 day", seconds: 86400 },
  { label: "7 days", seconds: 604800 },
]

/**
 * Hand a draft to someone who has no account.
 *
 * The link is the whole of their credential: a JWT signed with the project's own secret, carrying a
 * claim that names this one record and nothing else, and no subject at all, so holding it makes them
 * nobody rather than making them you.
 *
 * **The scope choice is deliberately not a toggle in the same place as the record link.** A project
 * link covers every unpublished draft there is, so it is not a slightly larger version of this
 * control, it is a different act with a different blast radius, and it lives in Settings where
 * project-wide things live.
 */
export function SharePreview({
  modelTable,
  recordId,
  previewUrl,
}: SharePreviewProps): React.ReactElement {
  const { mint, minting, error } = usePreviewLinks()
  const [ttl, setTtl] = useState(TTL_CHOICES[0]?.seconds ?? 900)
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null)
  const [copied, setCopied] = useState(false)

  const share = async () => {
    setLink(null)
    setCopied(false)
    const minted = await mint({ scope: "record", model: modelTable, recordId, ttl })
    if (minted === null) return
    setLink({ url: previewLinkUrl(minted.token, previewUrl), expiresAt: minted.expiresAt })
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Select
          value={String(ttl)}
          onChange={(e) => { setTtl(Number(e.target.value)) }}
          aria-label="How long the link lives"
        >
          {TTL_CHOICES.map((choice) => (
            <option key={choice.seconds} value={choice.seconds}>
              {choice.label}
            </option>
          ))}
        </Select>
        <Button size="sm" variant="secondary" disabled={minting} onClick={() => { void share() }}>
          {minting ? "Making a link…" : "Share a preview"}
        </Button>
      </div>

      {error !== null && <div className="text-xs text-destructive">{error}</div>}

      {link !== null && (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Input readOnly value={link.url} onFocus={(e) => { e.target.select() }} />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                void navigator.clipboard.writeText(link.url).then(
                  () => { setCopied(true) },
                  () => { setCopied(false) },
                )
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <div className="text-xs text-muted-foreground">
            Anyone with this link can read the draft until {formatExpiry(link.expiresAt)}. It is
            shown once: Studio does not keep it, because keeping it would be keeping a credential.
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The address to hand over.
 *
 * When the project has told Studio where previews are rendered, the token rides as a query
 * parameter on that page. Otherwise the token itself is the thing to share, because Studio has no
 * business guessing at somebody's front end and a wrong URL is worse than a bare token: it looks
 * like it should work.
 */
function previewLinkUrl(token: string, previewUrl?: string): string {
  if (previewUrl === undefined || previewUrl.trim() === "") return token
  const separator = previewUrl.includes("?") ? "&" : "?"
  return `${previewUrl}${separator}preview_token=${encodeURIComponent(token)}`
}

function formatExpiry(value: string): string {
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? value : at.toLocaleString()
}
