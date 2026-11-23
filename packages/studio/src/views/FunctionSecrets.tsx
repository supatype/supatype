import React, { useState } from "react"
import { useStudioClient } from "../StudioCore.js"
import { useApiQuery } from "../hooks/useApiQuery.js"
import { Button, Card, ConfirmButton, Input, SavedNotice, Table, Td, Th, type DestructiveQuestion } from "../components/ui.js"
import { EmptyState } from "../components/EmptyState.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
import { functionsAdminError, functionsAdminFetch, isDataList } from "../lib/functions-admin.js"
import { isString, readJson } from "../lib/json.js"

/**
 * The project's function secrets: the names the server holds in the functions' shared env file,
 * set and removed through `/admin/v1/functions/env`. A value is write-only, so the page can only
 * list names. The server writes the file and the worker reads it on each call, so a change applies
 * on the next call with nothing to restart (the CLI's `functions env set` says the same).
 */

function removeSecretQuestion(key: string): DestructiveQuestion {
  return {
    title: `Remove ${key}?`,
    detail: <p>The secret and its value are deleted. Studio never shows a value, so it cannot be recovered from here.</p>,
    answer: "Remove secret",
  }
}

export function FunctionSecrets(): React.ReactElement {
  const client = useStudioClient()
  const [key, setKey] = useState("")
  const [value, setValue] = useState("")
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const { data, loading, error: listError, refetch } = useApiQuery<string[]>(async () => {
    const res = await functionsAdminFetch(client, "/env")
    if (!res.ok) throw await functionsAdminError(res, "Could not list secrets")
    return (await readJson(res, isDataList(isString))).data ?? []
  }, [client])
  const names = data ?? []

  const handleSet = async (): Promise<void> => {
    if (!key.trim()) return
    setSaving(true)
    setActionError(null)
    setSavedAt(null)
    try {
      const res = await functionsAdminFetch(client, "/env", {
        method: "POST",
        body: JSON.stringify({ key: key.trim(), value }),
      })
      if (!res.ok) throw await functionsAdminError(res, "Could not set the secret")
      setKey("")
      setValue("")
      setSavedAt(Date.now())
      refetch()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not set the secret")
    } finally {
      setSaving(false)
    }
  }

  const handleRemove = async (name: string): Promise<void> => {
    setActionError(null)
    setSavedAt(null)
    try {
      const res = await functionsAdminFetch(client, `/env/${encodeURIComponent(name)}`, { method: "DELETE" })
      if (!res.ok) throw await functionsAdminError(res, "Could not remove the secret")
      refetch()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not remove the secret")
    }
  }

  const shownError = actionError ?? listError

  return (
    <Card className="p-4">
      <div className="mb-4">
        <h3 className="m-0">Function secrets</h3>
        <p className="text-[0.8rem] text-muted-foreground mt-1">
          Secrets are shared by every function and arrive in each function&apos;s <code>ctx.env</code>.
          A value is never shown again once saved; to change one, set the same name again. A change
          applies on the next call to a function.
        </p>
      </div>

      {shownError ? <ErrorBanner message={shownError} /> : null}

      <div className="flex gap-2 flex-wrap items-center mb-4">
        <Input placeholder="KEY" value={key} onChange={(e) => setKey(e.target.value)} className="font-mono text-xs w-48" />
        <Input
          type="password"
          placeholder="value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="font-mono text-xs flex-1 min-w-[160px]"
        />
        <Button variant="primary" size="sm" onClick={() => void handleSet()} disabled={saving || !key.trim()}>
          {saving ? "Saving…" : "Set secret"}
        </Button>
        <SavedNotice at={savedAt} />
      </div>

      {loading ? <div className="text-center py-6 text-xs text-muted-foreground">Loading…</div> : null}

      {!loading && !listError && names.length === 0 ? (
        <EmptyState title="No secrets set" description="Add a secret above to make it available in ctx.env." />
      ) : null}

      {!loading && names.length > 0 ? (
        <Card className="overflow-auto">
          <Table>
            <thead>
              <tr className="border-b border-border">
                <Th>Name</Th>
                <Th>Value</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {names.map((name) => (
                <tr key={name} className="border-b border-border last:border-0">
                  <Td className="font-mono text-xs">{name}</Td>
                  <Td className="text-xs text-muted-foreground font-mono">••••••••</Td>
                  <Td>
                    <ConfirmButton size="xs" variant="destructive" ask={removeSecretQuestion(name)} act={() => void handleRemove(name)}>
                      Remove
                    </ConfirmButton>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : null}
    </Card>
  )
}
