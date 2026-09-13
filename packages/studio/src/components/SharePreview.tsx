import React, { useCallback, useEffect, useState } from "react"
import { Button, Input, Select } from "./ui.js"
import { usePreviewLinks, type PreviewLinkSummary } from "../hooks/usePreviewLinks.js"
import { formatTimestamp } from "../lib/utils.js"

interface SharePreviewProps {
  /**
   * The model's name, which is the key `admin.livePreview` is written under.
   *
   * Distinct from the table name below, and the distinction matters: this message used to name the
   * table, so following it produced a config keyed on `posts` while Studio reads `Post`, and the
   * setting silently configured nothing.
   */
  modelName: string
  /** The model's table name, which is what the preview claim names. */
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
 * The link is the whole of their credential: a short code naming a row the project can revoke,
 * which the reader's browser exchanges for a token that lives about a minute and carries no
 * subject, so holding the link makes them nobody rather than making them you.
 *
 * **The scope choice is deliberately not a toggle in the same place as the record link.** A project
 * link covers every unpublished draft there is, so it is not a slightly larger version of this
 * control, it is a different act with a different blast radius, and it lives in Settings where
 * project-wide things live.
 */
export function SharePreview({
  modelName,
  modelTable,
  recordId,
  previewUrl,
}: SharePreviewProps): React.ReactElement {
  const { mint, list, revoke, minting, error } = usePreviewLinks()
  const [ttl, setTtl] = useState(TTL_CHOICES[0]?.seconds ?? 900)
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [existing, setExisting] = useState<PreviewLinkSummary[]>([])

  const configured = previewUrl !== undefined && previewUrl.trim() !== ""

  const reload = useCallback(async () => {
    // A model the project has not pointed anywhere renders the message below and can never show a
    // link, so asking for its links is a round trip answered into a void.
    if (!configured) return
    setExisting(await list(modelTable, recordId))
  }, [configured, list, modelTable, recordId])

  useEffect(() => {
    void reload()
  }, [reload])

  // Studio has no business guessing at somebody's front end, and a wrong URL is worse than none: it
  // looks like it should work. Handing over the bare code instead was worse still, because it looks
  // like a mistake and cannot be opened at all.
  if (!configured) {
    return (
      <div className="text-xs text-muted-foreground">
        To share a preview, tell Studio where this model renders: set{" "}
        <code>admin.livePreview</code> for <code>{modelName}</code> in your Supatype config.
      </div>
    )
  }

  const share = async (): Promise<void> => {
    setLink(null)
    setCopied(false)
    const minted = await mint({ scope: "record", model: modelTable, recordId, ttl })
    if (minted === null) return
    setLink({ url: previewLinkUrl(minted.code, previewUrl), expiresAt: minted.expiresAt })
    await reload()
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Select
          value={String(ttl)}
          onChange={(e) => {
            setTtl(Number(e.target.value))
          }}
          aria-label="How long the link lives"
        >
          {TTL_CHOICES.map((choice) => (
            <option key={choice.seconds} value={choice.seconds}>
              {choice.label}
            </option>
          ))}
        </Select>
        <Button
          size="sm"
          variant="secondary"
          disabled={minting}
          onClick={() => {
            void share()
          }}
        >
          {minting ? "Making a link…" : "Share a preview"}
        </Button>
      </div>

      {error !== null && <div className="text-xs text-destructive">{error}</div>}

      {link !== null && (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Input
              readOnly
              value={link.url}
              onFocus={(e) => {
                e.target.select()
              }}
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                void navigator.clipboard.writeText(link.url).then(
                  () => {
                    setCopied(true)
                  },
                  () => {
                    setCopied(false)
                  },
                )
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <div className="text-xs text-muted-foreground">
            Anyone with this link can read the draft until {formatTimestamp(link.expiresAt)}. It is
            shown once: Studio does not keep it, because keeping it would be keeping a credential.
          </div>
        </div>
      )}

      {existing.length > 0 && (
        <div className="space-y-1 pt-1">
          <div className="text-xs font-medium text-muted-foreground">Shared links</div>
          {/* Ids and times, never codes. The credential was shown once at mint; this exists so that
              somebody can see what they have given out and take one back, not so they can recover
              something they did not keep. */}
          {existing.map((row) => (
            <div key={row.id} className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                {row.scope === "project" ? "Whole project" : "This record"}, until{" "}
                {formatTimestamp(row.expiresAt)}
              </span>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  // Only re-read when something actually changed. Reloading after a refusal hides
                  // the refusal behind an unchanged list.
                  void revoke(row.id).then((done) => (done ? reload() : undefined))
                }}
              >
                Revoke
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * The address to hand over.
 *
 * The code rides as a query parameter on the page the project said renders this model. It is short
 * enough to survive being pasted into a message, which the signed token it replaced was not: that
 * ran to about 400 characters and wrapped into something unusable in mail.
 */
function previewLinkUrl(code: string, previewUrl: string): string {
  const separator = previewUrl.includes("?") ? "&" : "?"
  return `${previewUrl}${separator}preview=${encodeURIComponent(code)}`
}
