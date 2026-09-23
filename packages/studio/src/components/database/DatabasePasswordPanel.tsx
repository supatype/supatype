/**
 * Database password management.
 *
 * **Shown once, then reset-only.** The password is surfaced when the stack is created and
 * never again: there is no reveal here, deliberately. Recovering a stored credential into a
 * browser session means a stolen dashboard session is also a database credential, and the
 * only thing a reveal buys over a reset is not having to update connection strings.
 *
 * The host app provides `onResetPassword`, which returns the new password, that return value
 * is the one moment it is displayable, so the host is responsible for showing it.
 */

import { useState, useCallback, type FC } from "react"

// -- Types -------------------------------------------------------------------

export interface DatabasePasswordPanelProps {
  /** Called to reset the password. Should return the new password string. */
  onResetPassword: () => Promise<string>
  /** Called after a successful password reset with the new password, show it once. */
  onPasswordChanged: (newPassword: string) => void
}

// -- Component ---------------------------------------------------------------

export const DatabasePasswordPanel: FC<DatabasePasswordPanelProps> = ({
  onResetPassword,
  onPasswordChanged,
}) => {
  const [resetting, setResetting] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)

  const handleResetPassword = useCallback(async () => {
    if (!confirmReset) {
      setConfirmReset(true)
      return
    }

    setResetting(true)
    setResetError(null)

    try {
      const newPassword = await onResetPassword()
      onPasswordChanged(newPassword)
      setConfirmReset(false)
    } catch (err) {
      setResetError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setResetting(false)
    }
  }, [confirmReset, onResetPassword, onPasswordChanged])

  return (
    <div className="space-y-4">
      <h4 className="text-sm font-semibold">Database Password</h4>

      <p className="text-xs text-gray-500">
        The database password grants direct SQL access (bypasses PostgREST and RLS).
        It is separate from the anon and service_role API keys, which provide
        API access through PostgREST with RLS enforcement.
      </p>

      <p className="text-xs text-gray-500">
        It was shown once when this project was created and is not recoverable here. If you no
        longer have it, reset it below \u2014 the new password is shown once.
      </p>

      {/* Reset database password */}
      <div className="space-y-2">
        {confirmReset && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm dark:border-red-900 dark:bg-red-950">
            <p className="font-medium text-red-700 dark:text-red-400">
              Are you sure? This will:
            </p>
            <ul className="ml-4 mt-1 list-disc text-xs text-red-600 dark:text-red-400">
              <li>Generate a new database password</li>
              <li>Terminate all existing database connections</li>
              <li>Require updating your connection strings</li>
            </ul>
          </div>
        )}

        {resetError && (
          <p className="text-sm text-red-600">{resetError}</p>
        )}

        <div className="flex gap-2">
          <button
            onClick={handleResetPassword}
            disabled={resetting}
            className="rounded border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
          >
            {resetting ? "Resetting..." : confirmReset ? "Confirm reset" : "Reset database password"}
          </button>
          {confirmReset && (
            <button
              onClick={() => setConfirmReset(false)}
              className="rounded border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-100 dark:border-gray-600 dark:hover:bg-gray-800"
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
