/**
 * Connection string display panel.
 *
 * Shows the database connection string with:
 *   - Copy button
 *   - Password masked with a reveal toggle
 *   - Tabs for "Session mode" (port 5432) and "Transaction mode" (port 6432)
 *   - Explanatory note about the difference
 *   - Security notice about direct connections bypassing RLS
 */

import { useState, useCallback, type FC } from "react"

// -- Types -------------------------------------------------------------------

export interface ConnectionStringPanelProps {
  projectRef: string
  dbPassword: string
  dbHost: string
  tier: "free" | "pro" | "team" | "enterprise"
  onResetPassword: () => Promise<void>
}

type PoolMode = "session" | "transaction"

// -- Component ---------------------------------------------------------------

export const ConnectionStringPanel: FC<ConnectionStringPanelProps> = ({
  projectRef,
  dbPassword,
  dbHost,
  tier,
  onResetPassword,
}) => {
  const [activeTab, setActiveTab] = useState<PoolMode>("session")
  const [showPassword, setShowPassword] = useState(false)
  const [copied, setCopied] = useState(false)
  const [resetting, setResetting] = useState(false)

  const connectionString = buildConnectionString({
    ref: projectRef,
    password: showPassword ? dbPassword : "[YOUR-PASSWORD]",
    host: dbHost,
    mode: activeTab,
    tier,
  })

  const copyableString = buildConnectionString({
    ref: projectRef,
    password: dbPassword,
    host: dbHost,
    mode: activeTab,
    tier,
  })

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(copyableString)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [copyableString])

  const handleResetPassword = useCallback(async () => {
    setResetting(true)
    try {
      await onResetPassword()
    } finally {
      setResetting(false)
    }
  }, [onResetPassword])

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">Database Connection</h3>

      {/* Tab selector */}
      <div className="flex gap-2 border-b border-gray-200 dark:border-gray-700">
        <TabButton
          active={activeTab === "session"}
          onClick={() => setActiveTab("session")}
          label="Session mode"
          description="Port 5432"
        />
        <TabButton
          active={activeTab === "transaction"}
          onClick={() => setActiveTab("transaction")}
          label="Transaction mode"
          description="Port 6432"
        />
      </div>

      {/* Connection string display */}
      <div className="relative rounded-lg border border-gray-200 bg-gray-50 p-4 font-mono text-sm dark:border-gray-700 dark:bg-gray-900">
        <code className="block whitespace-pre-wrap break-all">
          {connectionString}
        </code>
        <div className="mt-3 flex gap-2">
          <button
            onClick={handleCopy}
            className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
          <button
            onClick={() => setShowPassword(!showPassword)}
            className="rounded border border-gray-300 px-3 py-1.5 text-xs font-medium hover:bg-gray-100 dark:border-gray-600 dark:hover:bg-gray-800"
          >
            {showPassword ? "Hide password" : "Reveal password"}
          </button>
        </div>
      </div>

      {/* Mode explanation */}
      <div className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm dark:border-blue-900 dark:bg-blue-950">
        {activeTab === "session" ? (
          <p>
            <strong>Session mode</strong> is for interactive tools (psql, DataGrip, TablePlus, DBeaver)
            and ORMs that need persistent connections. SET statements, LISTEN/NOTIFY, prepared
            statements, and advisory locks all work normally.
          </p>
        ) : (
          <p>
            <strong>Transaction mode</strong> is for application servers, serverless functions,
            and edge functions. Connections are returned to the pool after each transaction.
            SET statements do not persist across transactions.
          </p>
        )}
      </div>

      {/* Security notice */}
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950">
        <p>
          <strong>Security notice:</strong> Direct database connections have full access to all
          schemas and bypass Row Level Security (RLS). Use API keys (anon/service_role)
          for application access with RLS enforcement.
        </p>
      </div>

      {/* Password management */}
      <div className="flex items-center gap-4">
        <button
          onClick={handleResetPassword}
          disabled={resetting}
          className="rounded border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
        >
          {resetting ? "Resetting..." : "Reset database password"}
        </button>
        <p className="text-xs text-gray-500">
          Generates a new password. Existing connections will be dropped.
        </p>
      </div>
    </div>
  )
}

// -- Sub-components ----------------------------------------------------------

interface TabButtonProps {
  active: boolean
  onClick: () => void
  label: string
  description: string
}

const TabButton: FC<TabButtonProps> = ({ active, onClick, label, description }) => (
  <button
    onClick={onClick}
    className={`border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
      active
        ? "border-blue-600 text-blue-600"
        : "border-transparent text-gray-500 hover:text-gray-700"
    }`}
  >
    {label}
    <span className="ml-1 text-xs text-gray-400">({description})</span>
  </button>
)

// -- Helpers -----------------------------------------------------------------

function buildConnectionString(opts: {
  ref: string
  password: string
  host: string
  mode: PoolMode
  tier: string
}): string {
  const { ref, password, host, mode, tier } = opts
  const role = `${ref}_role`

  if (mode === "session") {
    const base = `postgresql://${role}:${password}@${host}:5432/shared?sslmode=require`
    if (tier === "free") {
      return `${base}&options=-c%20search_path%3D${ref},extensions`
    }
    return base
  }

  return `postgresql://${role}:${password}@${host}:6432/shared?sslmode=require`
}
