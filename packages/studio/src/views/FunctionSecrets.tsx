import React, { useState } from "react"
import { useApiQuery } from "../hooks/useApiQuery.js"
import { useSecretsFetch, type SecretScope } from "../hooks/useSecretsFetch.js"
import { Button, Card, ConfirmButton, Input, SavedNotice, Table, Td, Th, type DestructiveQuestion } from "../components/ui.js"
import { EmptyState } from "../components/EmptyState.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
import { FieldError } from "../widgets/field-parts.js"
import { functionsAdminError, isDataList } from "../lib/functions-admin.js"
import { isString, readJson } from "../lib/json.js"
import { functionSecretNameProblem } from "@supatype/types"

/**
 * The one place function secrets are managed. Data hooks run as functions and read the same store
 * from `ctx.env`, so every section that shows secrets shows this component. A value is write-only,
 * so the page can only list names. The server writes the store and the worker reads it on each call,
 * so a change applies on the next call with nothing to restart.
 *
 * `scope` is "shared" (every function and hook; the default) or one function's own secrets, which
 * override a shared one of the same name, on self-host and on Cloud. Where the
 * secrets are served in each deployment mode is `useSecretsFetch`.
 */

const JSON_BODY = { "Content-Type": "application/json" }

function removeSecretQuestion(key: string): DestructiveQuestion {
  return {
    title: `Remove ${key}?`,
    detail: <p>The secret and its value are deleted. Studio never shows a value, so it cannot be recovered from here.</p>,
    answer: "Remove secret",
  }
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback
}

/** The heading and explanation of a scope. */
function scopeWords(scope: SecretScope): { title: string; about: React.ReactNode } {
  if (scope.kind === "function") {
    return {
      title: `Secrets for ${scope.name}`,
      about: <>Only {scope.name} receives these in its <code>ctx.env</code>, and they override a shared secret of the same name. A value is never shown again once saved. A change applies on the next call.</>,
    }
  }
  return {
    title: "Function secrets",
    about: <>Secrets are shared by every function and data hook and arrive in each one&apos;s <code>ctx.env</code>. A value is never shown again once saved; to change one, set the same name again. A change applies on the next call to a function.</>,
  }
}

export function FunctionSecrets({ scope = { kind: "shared" } }: { scope?: SecretScope }): React.ReactElement {
  const secretsFetch = useSecretsFetch(scope)
  const [key, setKey] = useState("")
  const [value, setValue] = useState("")
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const name = key.trim()
  const problem = name === "" ? null : (functionSecretNameProblem(name) ?? null)
  const words = scopeWords(scope)

  const { data, loading, error: listError, refetch } = useApiQuery<string[]>(async () => {
    const res = await secretsFetch("")
    if (!res.ok) throw await functionsAdminError(res, "Could not list secrets")
    return (await readJson(res, isDataList(isString))).data ?? []
  }, [secretsFetch])
  const names = data ?? []

  const handleSet = async (): Promise<void> => {
    if (name === "" || problem !== null) return
    setSaving(true)
    setActionError(null)
    setSavedAt(null)
    try {
      const res = await secretsFetch("", { method: "POST", headers: JSON_BODY, body: JSON.stringify({ key: name, value }) })
      if (!res.ok) throw await functionsAdminError(res, "Could not set the secret")
      setKey("")
      setValue("")
      setSavedAt(Date.now())
      refetch()
    } catch (err) {
      setActionError(errorText(err, "Could not set the secret"))
    } finally {
      setSaving(false)
    }
  }

  const handleRemove = async (secret: string): Promise<void> => {
    setActionError(null)
    setSavedAt(null)
    try {
      const res = await secretsFetch(`/${encodeURIComponent(secret)}`, { method: "DELETE" })
      if (!res.ok) throw await functionsAdminError(res, "Could not remove the secret")
      refetch()
    } catch (err) {
      setActionError(errorText(err, "Could not remove the secret"))
    }
  }

  const shownError = actionError ?? listError

  return (
    <Card className="p-4" role="region" aria-label={words.title}>
      <div className="mb-4">
        <h3 className="m-0">{words.title}</h3>
        <p className="text-[0.8rem] text-muted-foreground mt-1">{words.about}</p>
      </div>

      {shownError ? <ErrorBanner message={shownError} /> : null}

      <div className="flex gap-2 flex-wrap items-start mb-4">
        <div className="flex flex-col">
          <Input
            placeholder="KEY"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            aria-invalid={problem !== null}
            {...(problem !== null && { "aria-describedby": "secret-name-error" })}
            className="font-mono text-xs w-48"
          />
          {problem !== null && <FieldError id="secret-name-error">{problem}</FieldError>}
        </div>
        <Input
          type="password"
          placeholder="value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="font-mono text-xs flex-1 min-w-[160px]"
        />
        <Button variant="primary" size="sm" onClick={() => void handleSet()} disabled={saving || name === "" || problem !== null}>
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
              {names.map((secret) => (
                <tr key={secret} className="border-b border-border last:border-0">
                  <Td className="font-mono text-xs">{secret}</Td>
                  <Td className="text-xs text-muted-foreground font-mono">••••••••</Td>
                  <Td>
                    <ConfirmButton size="xs" variant="destructive" ask={removeSecretQuestion(secret)} act={() => void handleRemove(secret)}>
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
