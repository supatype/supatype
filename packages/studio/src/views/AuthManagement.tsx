import React, { useState, useCallback, useEffect, useRef } from "react"
import { useSearchParams } from "react-router-dom"
import { useStudioClient } from "../StudioCore.js"
import { useApiQuery, type ApiQueryResult } from "../hooks/useApiQuery.js"
import { useDebouncedValue } from "../hooks/useDebouncedValue.js"
import {
  authUserListPath,
  NO_USER_FILTERS,
  USER_ID_PATTERN,
  userFilterParams,
  userListTotal,
  userSearchTerm,
  type UserFilters,
} from "../lib/auth-user-search.js"
import { useStudioMembers } from "../hooks/useStudioMembers.js"
import { useStudioCapability } from "../hooks/useStudioCapability.js"
import { userAdministrationOffered, adminAccountChangeOffered, accountRemovalOffered, ADMIN_ACCOUNT_LOCKED } from "../lib/capability-offers.js"
import { authRefusalText } from "../lib/auth-refusal.js"
import { useAuthSettings } from "../hooks/useAuthSettings.js"
import { StudioAccessCell } from "../components/StudioAccessCell.js"
import { studioAuthHeaders } from "../lib/studio-auth-headers.js"
import {
  type Guard,
  isArrayOf,
  isJsonObject,
  isShape,
  isString,
  isUnknown,
  nullable,
  optional,
  parseJsonObject,
  readJson,
  readJsonObject,
} from "../lib/json.js"
import { Badge, Button, Card, Checkbox, CodeBlock, ConfirmButton, Input, Pager, Select, Table, Textarea, Th, Td, type DestructiveQuestion } from "../components/ui.js"
import { EmptyState } from "../components/EmptyState.js"
import { ErrorBanner } from "../components/ErrorBanner.js"
import { useRoleRefusalText } from "../components/RoleGate.js"
import { unlessRoleRefused } from "../lib/role-refusal.js"
import { SlidePanel } from "../components/SlidePanel.js"
import { useShowsProjectRows } from "../components/ElevatedModeBanner.js"

// ─── Types ────────────────────────────────────────────────────────────────────

interface AuthUser {
  id: string
  email: string
  phone: string | null
  role: string
  confirmed: boolean
  disabled: boolean
  last_sign_in: string | null
  created_at: string
  updated_at: string
  metadata: Record<string, unknown>
  providers: AuthIdentity[]
  mfa_factors: MfaFactor[]
}

interface AuthIdentity {
  provider: string
  provider_id: string
  linked_at: string
}

interface MfaFactor {
  id: string
  /**
   * The factor kind that was enrolled, rendered verbatim.
   *
   * Not narrowed to `"totp"`: phone factors are enrolled too, and the mapper was casting through
   * `any` to satisfy a literal it could not honour. A card reading "phone" is right; one reading
   * "totp" over a phone factor is a lie about someone's second factor.
   */
  type: string
  friendly_name: string | null
  created_at: string
  verified: boolean
}

interface AuthSession {
  id: string
  user_id: string
  ip: string
  user_agent: string
  created_at: string
  updated_at: string
}

/** One session as the auth admin API's GET /admin/sessions answers it. */
interface AuthSessionResponse {
  id: string
  user_id: string
  ip: string | null
  user_agent: string | null
  created_at: string
  updated_at: string
}

const isAuthSessionResponse: Guard<AuthSessionResponse> = isShape({
  id: isString,
  user_id: isString,
  ip: nullable(isString),
  user_agent: nullable(isString),
  created_at: isString,
  updated_at: isString,
})

function mapAuthSession(s: AuthSessionResponse): AuthSession {
  return { ...s, ip: s.ip ?? "", user_agent: s.user_agent ?? "" }
}

const availableRoles = ["authenticated"]
const providerFilters = ["all", "email", "github", "google", "apple"]
const statusFilters = ["all", "active", "disabled", "unconfirmed"]

// ─── Create/Edit User Form ────────────────────────────────────────────────────

/** What the form offers only when creating a user. */
interface CreateUserOptions {
  /**
   * Studio roles this viewer may grant, empty when they may not grant any.
   *
   * An existing user's Studio access is edited in the list, where the server's own refusals (no
   * self-change, no demoting the last admin) are already handled.
   */
  studioRoles: readonly string[]
  /**
   * The project's email auto-confirm setting, which seeds the Auto-confirm email checkbox; null
   * until the auth server has answered. The auth server confirms an admin-created user only when
   * asked to: its own auto-confirm setting covers public sign-ups, not this API.
   */
  autoConfirmDefault: boolean | null
}

interface UserFormData {
  email: string
  role: string
  password?: string
  metadata: Record<string, unknown>
  studioRole?: string
  /** Create only: whether the auth server marks the address confirmed. */
  emailConfirm?: boolean
}

function AutoConfirmField({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }): React.ReactElement {
  return (
    <div>
      <Checkbox label="Auto-confirm email" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <p className="text-[0.75rem] text-muted-foreground mt-1">
        Marks the address as confirmed, so the user can sign in without a confirmation email.
        Defaults to the project's email confirmation setting.
      </p>
    </div>
  )
}

/**
 * The metadata editor's text as an object, or why it is not one. Valid JSON is not enough: `[]`,
 * `"x"` and `null` all parse, and each used to be saved as the user's metadata.
 */
export function parseMetadata(json: string): { metadata: Record<string, unknown> } | { error: string } {
  const parsed = parseJsonObject(json)
  if (parsed.ok) return { metadata: parsed.value }
  return { error: parsed.error === "not-json" ? "Invalid JSON in metadata" : "Metadata must be a JSON object" }
}

function UserForm({
  user,
  create,
  onSave,
  onCancel,
}: {
  user: AuthUser | null
  /** Present when creating, absent when editing `user`. */
  create?: CreateUserOptions
  onSave: (data: UserFormData) => void
  onCancel: () => void
}): React.ReactElement {
  const studioRoles = create?.studioRoles ?? []
  const [email, setEmail] = useState(user?.email ?? "")
  const role = user?.role ?? "authenticated"
  const [studioRole, setStudioRole] = useState("")
  const [password, setPassword] = useState("")
  // Null until the checkbox is touched, so the default follows the setting when it arrives late.
  const [autoConfirmChoice, setAutoConfirmChoice] = useState<boolean | null>(null)
  const autoConfirm = autoConfirmChoice ?? create?.autoConfirmDefault ?? false
  const [metadataJson, setMetadataJson] = useState(JSON.stringify(user?.metadata ?? {}, null, 2))
  const [error, setError] = useState<string | null>(null)

  const handleSave = () => {
    if (!email.trim()) { setError("Email is required"); return }
    if (!user && !password.trim()) { setError("Password is required for new users"); return }

    const parsed = parseMetadata(metadataJson)
    if ("error" in parsed) { setError(parsed.error); return }
    const { metadata } = parsed

    onSave({
      email: email.trim(),
      role,
      ...(password.trim() ? { password: password.trim() } : {}),
      metadata,
      ...(studioRole !== "" ? { studioRole } : {}),
      ...(create !== undefined ? { emailConfirm: autoConfirm } : {}),
    })
  }

  return (
    <div>
      <div className="grid grid-cols-1 gap-3 max-w-[500px]">
        <div>
          <label className="block text-[0.8rem] text-muted-foreground mb-1">Email <span className="text-red-400">*</span></label>
          <Input value={email} onChange={(e) => { setEmail(e.target.value); setError(null) }} />
        </div>
        <div>
          <label className="block text-[0.8rem] text-muted-foreground mb-1">
            Password {user ? "(leave blank to keep current)" : ""} {!user ? <span className="text-red-400">*</span> : null}
          </label>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {create !== undefined ? <AutoConfirmField checked={autoConfirm} onChange={setAutoConfirmChoice} /> : null}
        <div>
          <label className="block text-[0.8rem] text-muted-foreground mb-1">Project role</label>
          <Input value={role} disabled readOnly />
          <p className="text-[0.75rem] text-muted-foreground mt-1">
            Project users are always provisioned as <code>authenticated</code>.
          </p>
        </div>
        {studioRoles.length > 0 ? (
          <div>
            <label className="block text-[0.8rem] text-muted-foreground mb-1">Studio access</label>
            <Select value={studioRole} onChange={(e) => setStudioRole(e.target.value)}>
              <option value="">No access</option>
              {studioRoles.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
            <p className="text-[0.75rem] text-muted-foreground mt-1">
              {/* Named apart from the project role above because conflating the two is how
                  granting an application role would hand out admin UI access. */}
              Whether this person may use Studio, and with what permissions. Separate from the
              project role: it grants nothing in your own application.
            </p>
          </div>
        ) : null}
        <div>
          <label className="block text-[0.8rem] text-muted-foreground mb-1">User Metadata (JSON)</label>
          <Textarea
            aria-label="User metadata (JSON)"
            className="min-h-[80px] resize-y"
            value={metadataJson}
            onChange={(e) => { setMetadataJson(e.target.value); setError(null) }}
          />
        </div>
        {error ? <div className="text-red-400 text-xs">{error}</div> : null}
        <div className="flex gap-2">
          <Button variant="primary" onClick={handleSave}>{user ? "Save Changes" : "Create User"}</Button>
          <Button onClick={onCancel}>Cancel</Button>
        </div>
      </div>
    </div>
  )
}

// ─── User Detail View ─────────────────────────────────────────────────────────

/**
 * The drawer's actions. The account ones are null on a Studio admin's account when the caller is
 * not an admin: the server refuses them, so they are not offered.
 */
interface UserDetailActions {
  account: UserAccountActions | null
  /** Undefined when the viewer may not administer users, so the action is not offered. */
  onConfirmEmail: (() => void) | undefined
  /**
   * Why the last action was refused, said right above the action buttons: a drawer listing many
   * sessions is scrolled to its bottom to reach them, out of sight of its top.
   */
  refusal: string | null
}

/** What may be done to one user's account from the drawer. Disable and Delete are null on the caller's own. */
interface UserAccountActions {
  onToggleDisable: (() => void) | null
  onEdit: () => void
  onDelete: (() => void) | null
  onRevokeSession: (sessionId: string) => void
}

function UserDetail({
  user,
  sessions,
  actions,
}: {
  user: AuthUser
  sessions: AuthSession[]
  actions: UserDetailActions
}): React.ReactElement {
  const { account, onConfirmEmail, refusal } = actions
  const userSessions = sessions.filter((s) => s.user_id === user.id)

  return (
    <div className="space-y-6">
      {/* Profile info */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div>
          <label className="block text-[0.7rem] text-muted-foreground uppercase mb-0.5">Role</label>
          <Badge variant={user.role === "admin" ? "indigo" : "green"}>{user.role}</Badge>
        </div>
        <div>
          <label className="block text-[0.7rem] text-muted-foreground uppercase mb-0.5">Status</label>
          {user.disabled
            ? <Badge variant="red">Disabled</Badge>
            : <Badge variant="green">Active</Badge>
          }
        </div>
        <div>
          <label className="block text-[0.7rem] text-muted-foreground uppercase mb-0.5">Confirmed</label>
          <span className="text-sm">{user.confirmed ? "Yes" : "Pending"}</span>
        </div>
        <div>
          <label className="block text-[0.7rem] text-muted-foreground uppercase mb-0.5">Phone</label>
          <span className="text-sm">{user.phone ?? <span className="text-zinc-600">Not set</span>}</span>
        </div>
        <div>
          <label className="block text-[0.7rem] text-muted-foreground uppercase mb-0.5">Last Sign-in</label>
          <span className="text-sm">{user.last_sign_in ? new Date(user.last_sign_in).toLocaleString() : "Never"}</span>
        </div>
        <div>
          <label className="block text-[0.7rem] text-muted-foreground uppercase mb-0.5">Created</label>
          <span className="text-sm">{new Date(user.created_at).toLocaleString()}</span>
        </div>
      </div>

      {/* Metadata */}
      <div className="mb-6">
        <h4 className="text-sm text-muted-foreground mb-2">Metadata</h4>
        <CodeBlock className="text-xs">{JSON.stringify(user.metadata, null, 2)}</CodeBlock>
      </div>

      {/* Linked identities / providers */}
      <div className="mb-6">
        <h4 className="text-sm text-muted-foreground mb-2">Linked Identities</h4>
        <Card className="overflow-auto">
          <Table>
            <thead>
              <tr className="border-b border-border">
                <Th>Provider</Th>
                <Th>Provider ID</Th>
                <Th>Linked</Th>
              </tr>
            </thead>
            <tbody>
              {user.providers.map((p) => (
                <tr key={p.provider} className="border-b border-border">
                  <Td><Badge variant="blue">{p.provider}</Badge></Td>
                  <Td className="text-xs font-mono">{p.provider_id}</Td>
                  <Td className="text-xs text-muted-foreground">{new Date(p.linked_at).toLocaleDateString()}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>

      {/* MFA Factors */}
      {user.mfa_factors.length > 0 ? (
        <div className="mb-6">
          <h4 className="text-sm text-muted-foreground mb-2">MFA Factors</h4>
          <Card className="overflow-auto">
            <Table>
              <thead>
                <tr className="border-b border-border">
                  <Th>Type</Th>
                  <Th>Name</Th>
                  <Th>Verified</Th>
                  <Th>Created</Th>
                </tr>
              </thead>
              <tbody>
                {user.mfa_factors.map((f) => (
                  <tr key={f.id} className="border-b border-border">
                    <Td><Badge variant="indigo">{f.type}</Badge></Td>
                    <Td>{f.friendly_name ?? "Unnamed"}</Td>
                    <Td>{f.verified ? <Badge variant="green">Yes</Badge> : <Badge variant="yellow">No</Badge>}</Td>
                    <Td className="text-xs text-muted-foreground">{new Date(f.created_at).toLocaleDateString()}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </div>
      ) : null}

      {/* Sessions */}
      <div className="mb-6">
        <h4 className="text-sm text-muted-foreground mb-2">Active Sessions ({userSessions.length})</h4>
        {userSessions.length > 0 ? (
          <Card className="overflow-auto">
            <Table>
              <thead>
                <tr className="border-b border-border">
                  <Th>Device</Th>
                  <Th>IP</Th>
                  <Th>Last Active</Th>
                  <Th>Actions</Th>
                </tr>
              </thead>
              <tbody>
                {userSessions.map((s) => (
                  <tr key={s.id} className="border-b border-border">
                    <Td className="text-xs">{s.user_agent || <span className="text-zinc-600">Unknown</span>}</Td>
                    <Td className="font-mono text-xs">{s.ip || "-"}</Td>
                    <Td className="text-xs text-muted-foreground">{new Date(s.updated_at).toLocaleString()}</Td>
                    <Td>
                      {account ? (
                        <ConfirmButton size="xs" variant="destructive" ask={REVOKE_QUESTION} act={() => account.onRevokeSession(s.id)}>
                          Revoke
                        </ConfirmButton>
                      ) : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        ) : (
          <p className="text-xs text-zinc-600">No active sessions</p>
        )}
      </div>

      {/* Actions */}
      {refusal !== null ? <RefusalNotice message={refusal} /> : null}
      {account ? (
        <div data-user-actions="" className="flex gap-2 flex-wrap">
          <Button onClick={account.onEdit}>Edit User</Button>
          {!user.confirmed && onConfirmEmail ? <Button onClick={onConfirmEmail}>Confirm email</Button> : null}
          {account.onToggleDisable !== null ? <UserBanToggle user={user} toggle={account.onToggleDisable} /> : null}
          {/* No Impersonate action until Studio can run its own editors as the user (IMP1). */}
          {account.onDelete !== null ? <DeleteUserAction email={user.email} onDelete={account.onDelete} /> : null}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{ADMIN_ACCOUNT_LOCKED}</p>
      )}
    </div>
  )
}

/** A refused action's reason, brought into view: it can appear below the drawer's visible part. */
function RefusalNotice({ message }: { message: string }): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: "nearest" })
  }, [message])
  return <div ref={ref}><ErrorBanner message={message} /></div>
}

/**
 * Delete User, which asks first. A refusal, such as the last Studio admin's, is shown by the
 * drawer, which stays open.
 */
function DeleteUserAction({ email, onDelete }: { email: string; onDelete: () => void }): React.ReactElement {
  const ask = { title: `Delete "${email}"?`, detail: <p>The account is deleted for good. This cannot be undone.</p>, answer: "Delete" }
  return <ConfirmButton variant="destructive" ask={ask} act={onDelete}>Delete User</ConfirmButton>
}

/** Revoking a session signs out the device that holds it. */
const REVOKE_QUESTION: DestructiveQuestion = {
  title: "Revoke this session?",
  detail: <p>The device signed in with this session is signed out, and has to sign in again.</p>,
  answer: "Revoke session",
}

/**
 * Enable or Disable a user, in the drawer and on the list's rows (`compact`). Enabling only lets
 * someone back in, so it happens on the click; disabling locks them out, so it asks first.
 */
function UserBanToggle({ user, toggle, compact = false }: {
  user: { email: string; disabled: boolean }
  toggle: () => void
  compact?: boolean
}): React.ReactElement {
  const size = compact ? "xs" : "sm"
  const noun = compact ? "" : " User"
  if (user.disabled) return <Button size={size} onClick={toggle}>Enable{noun}</Button>
  const ask = {
    title: `Disable ${user.email}?`,
    detail: <p>They cannot sign in until the account is enabled again.</p>,
    answer: "Disable user",
  }
  return <ConfirmButton size={size} ask={ask} act={toggle}>Disable{noun}</ConfirmButton>
}

// ─── Invite User Form ─────────────────────────────────────────────────────────

function InviteUserForm({
  onInvite,
  onCancel,
}: {
  onInvite: (email: string) => void
  onCancel: () => void
}): React.ReactElement {
  const [email, setEmail] = useState("")
  const role = "authenticated"

  return (
    <div>
      <p className="text-xs text-muted-foreground mb-4">
        An invitation email will be sent to the user with a magic link to confirm their account.
      </p>
      <div className="flex gap-2 items-end max-w-[500px]">
        <div className="flex-1">
          <label className="block text-[0.8rem] text-muted-foreground mb-1">Email</label>
          <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="user@example.com" />
        </div>
        <div className="w-[140px]">
          <label className="block text-[0.8rem] text-muted-foreground mb-1">Role</label>
          <Input value={role} disabled />
        </div>
        <Button variant="primary" onClick={() => { if (email.trim()) onInvite(email.trim()) }}>
          Send Invite
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

/**
 * A user as the auth admin API returns it, which is not the AuthUser above: that
 * one is what this view renders, with the fields it needs and no nulls. Sharing
 * the name merged the two declarations and made every field of the rendered user
 * optional.
 *
 * Every field but the ids optional, because this describes someone else's JSON rather than a
 * value we constructed: a server that stops sending `factors` or a timestamp should narrow what
 * Studio can show, not throw while mapping. `any` here would have hidden exactly that.
 */
interface AuthUserResponse {
  id: string
  email?: string | null
  phone?: string | null
  role?: string | null
  email_confirmed_at?: string | null
  banned_until?: string | null
  last_sign_in_at?: string | null
  created_at?: string | null
  updated_at?: string | null
  user_metadata?: Record<string, unknown> | null
  identities?: AuthIdentityResponse[] | null
  factors?: AuthFactorResponse[] | null
}

interface AuthIdentityResponse {
  provider: string
  identity_id?: string | null
  id?: string | null
  created_at?: string | null
}

interface AuthFactorResponse {
  id: string
  factor_type?: string | null
  type?: string | null
  friendly_name?: string | null
  created_at?: string | null
  status?: string | null
}

const optionalText = optional(nullable(isString))

const isAuthIdentityResponse: Guard<AuthIdentityResponse> = isShape({
  provider: isString,
  identity_id: optionalText,
  id: optionalText,
  created_at: optionalText,
})

const isAuthFactorResponse: Guard<AuthFactorResponse> = isShape({
  id: isString,
  factor_type: optionalText,
  type: optionalText,
  friendly_name: optionalText,
  created_at: optionalText,
  status: optionalText,
})

const isAuthUserResponse: Guard<AuthUserResponse> = isShape({
  id: isString,
  email: optionalText,
  phone: optionalText,
  role: optionalText,
  email_confirmed_at: optionalText,
  banned_until: optionalText,
  last_sign_in_at: optionalText,
  created_at: optionalText,
  updated_at: optionalText,
  user_metadata: optional(nullable(isJsonObject)),
  identities: optional(nullable(isArrayOf(isAuthIdentityResponse))),
  factors: optional(nullable(isArrayOf(isAuthFactorResponse))),
})

const isUserList = isShape({ users: isArrayOf(isAuthUserResponse) })
const isSessionList = isShape({ sessions: isArrayOf(isAuthSessionResponse) })
const isCreatedUser = isShape({ id: optional(isUnknown) })

/**
 * How a user signs in. A password user made outside the sign-up flow (`supatype admin create-user`)
 * has no identity row, so a user with an email and no identity signs in with email.
 */
function providersOf(raw: AuthUserResponse): AuthIdentity[] {
  const identities = (raw.identities ?? []).map((i) => ({
    provider: i.provider,
    provider_id: i.identity_id ?? i.id ?? "",
    linked_at: i.created_at ?? "",
  }))
  if (identities.length > 0 || !raw.email) return identities
  return [{ provider: "email", provider_id: raw.id, linked_at: raw.created_at ?? "" }]
}

export function mapAuthUser(raw: AuthUserResponse): AuthUser {
  return {
    id: raw.id,
    email: raw.email ?? "",
    phone: raw.phone || null,
    role: raw.role ?? "authenticated",
    confirmed: raw.email_confirmed_at != null,
    disabled: raw.banned_until != null,
    last_sign_in: raw.last_sign_in_at ?? null,
    created_at: raw.created_at ?? "",
    updated_at: raw.updated_at ?? "",
    metadata: raw.user_metadata ?? {},
    providers: providersOf(raw),
    mfa_factors: Array.isArray(raw.factors)
      ? raw.factors.map((f) => ({
          id: f.id,
          type: f.factor_type ?? f.type ?? "totp",
          friendly_name: f.friendly_name ?? null,
          created_at: f.created_at ?? "",
          verified: f.status === "verified",
        }))
      : [],
  }
}

// ─── User list rows ───────────────────────────────────────────────────────────

/** On a phone only Email and Actions are columns; these step aside below `md`. */
const WIDE_ONLY = "hidden md:table-cell"

/** The users table's header. Studio access is Studio's own namespace, kept apart from the app role. */
function UserTableHead(): React.ReactElement {
  const wide = ["Role", "Studio access", "Providers", "Confirmed", "Status", "MFA", "Last Sign-in", "Created"]
  return (
    <thead>
      <tr className="border-b border-border">
        <Th>Email</Th>
        {wide.map((label) => <Th key={label} className={WIDE_ONLY}>{label}</Th>)}
        <Th>Actions</Th>
      </tr>
    </thead>
  )
}

/** Who may change Studio access, for the Studio access cell. */
type StudioAccessView = Omit<React.ComponentProps<typeof StudioAccessCell>, "userId">

/** What a row's buttons do; `toggle` is null where the account may not be changed. */
interface UserRowActions {
  open: () => void
  toggle: (() => void) | null
}

function UserRow({ user, access, actions }: { user: AuthUser; access: StudioAccessView; actions: UserRowActions }): React.ReactElement {
  // A column each on a wide screen, stacked under the email on a phone. The email gives way first:
  // it may wrap anywhere, so a long address narrows its own column rather than pushing Actions
  // past the card's edge.
  const studio = <StudioAccessCell userId={user.id} {...access} />
  const status = user.disabled ? <Badge variant="red">Disabled</Badge> : <Badge variant="green">Active</Badge>
  const mfa = user.mfa_factors.length
  return (
    <tr className="border-b border-border hover:bg-accent/50 cursor-pointer" onClick={actions.open}>
      <Td className="font-medium [overflow-wrap:anywhere]">
        {user.email}
        <div className="md:hidden mt-1 flex flex-wrap items-center gap-2 font-normal">{studio}{status}</div>
      </Td>
      <Td className={WIDE_ONLY}><Badge variant={user.role === "admin" ? "indigo" : "green"}>{user.role}</Badge></Td>
      <Td className={WIDE_ONLY}>{studio}</Td>
      <Td className={WIDE_ONLY}>
        <div className="flex gap-1">
          {user.providers.map((p) => <Badge key={p.provider} variant="blue" className="text-[0.6rem]">{p.provider}</Badge>)}
        </div>
      </Td>
      <Td className={WIDE_ONLY}>{user.confirmed ? "Yes" : <span className="text-yellow-400">Pending</span>}</Td>
      <Td className={WIDE_ONLY}>{status}</Td>
      <Td className={WIDE_ONLY}>
        {mfa > 0 ? <Badge variant="indigo">{mfa} factor{mfa !== 1 ? "s" : ""}</Badge> : <span className="text-zinc-600 text-xs">None</span>}
      </Td>
      <Td className={`${WIDE_ONLY} text-xs text-muted-foreground`}>{user.last_sign_in ? new Date(user.last_sign_in).toLocaleDateString() : "Never"}</Td>
      <Td className={`${WIDE_ONLY} text-xs text-muted-foreground`}>{new Date(user.created_at).toLocaleDateString()}</Td>
      <Td>
        <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
          {actions.toggle !== null ? <UserBanToggle compact user={user} toggle={actions.toggle} /> : null}
          <Button size="xs" onClick={actions.open} title="View details">View</Button>
        </div>
      </Td>
    </tr>
  )
}

// ─── The user list, a page at a time ─────────────────────────────────────────

/** The auth server's own default page size (`defaultPerPage` in its pagination.go). */
const USERS_PAGE_SIZE = 50
const SEARCH_DEBOUNCE_MS = 300

/** One request to the auth admin API, answered whatever its status. */
type AuthRequest = (path: string, options?: RequestInit) => Promise<Response>

/** The page asked for, zero based, and the search and choices the server filters the users by. */
interface UserQuery {
  filter: string
  page: number
  filters: UserFilters
}

/** The users on one page, which page it is, and how many users match in all. */
interface UserPage {
  users: AuthUser[]
  page: number
  total: number
}

const NO_USERS: UserPage = { users: [], page: 0, total: 0 }

/** `res` when the auth server accepted the request; its refusal, in its own words, when not. */
async function acceptedResponse(res: Response): Promise<Response> {
  if (!res.ok) throw new Error(authRefusalText(await readJsonObject(res)) ?? `The auth server refused the request (HTTP ${res.status}).`)
  return res
}

/** One page of the list, with the total the server sends in X-Total-Count. */
async function readUserPage(res: Response, page: number): Promise<UserPage> {
  const users = (await readJson(res, isUserList)).users.map(mapAuthUser)
  return { users, page, total: userListTotal(res, { filter: "", page, perPage: USERS_PAGE_SIZE }, users.length) }
}

/** The list path for one page of `query`. */
function userPagePath(query: UserQuery): string {
  return authUserListPath({ ...query, perPage: USERS_PAGE_SIZE })
}

/** The one user with this ID, since the server's filter does not search IDs. */
async function fetchUserById(request: AuthRequest, id: string): Promise<UserPage> {
  const res = await request(`/users/${encodeURIComponent(id)}`)
  if (res.status === 404) return NO_USERS
  const user = await readJson(await acceptedResponse(res), isAuthUserResponse)
  return { users: [mapAuthUser(user)], page: 0, total: 1 }
}

/**
 * The page `query` asks for. A page left empty under the viewer, by deleting its last user, falls
 * back to the last page that still has users rather than showing none.
 */
async function fetchUserPage(request: AuthRequest, query: UserQuery): Promise<UserPage> {
  if (USER_ID_PATTERN.test(query.filter)) return fetchUserById(request, query.filter)
  const page = await readUserPage(await acceptedResponse(await request(userPagePath(query))), query.page)
  const last = Math.max(0, Math.ceil(page.total / USERS_PAGE_SIZE) - 1)
  if (page.users.length > 0 || query.page <= last) return page
  return readUserPage(await acceptedResponse(await request(userPagePath({ ...query, page: last }))), last)
}

interface UserList extends ApiQueryResult<UserPage> {
  /** The search box's text, every keystroke of it. */
  search: string
  setSearch: (search: string) => void
  /** What was last asked of the server: the search once typing paused, the choices, and the page. */
  query: UserQuery
  setPage: (page: number) => void
  /** New role, status or provider choices, from the first page. */
  setFilters: (filters: UserFilters) => void
}

/**
 * The user list, searched and paged by the auth server, so every user can be seen and found. It used
 * to read the first 50 users and search those in the browser, which hid everyone after them.
 *
 * The search is handed on only once typing pauses, together with a return to the first page, so a
 * new search and its first page are asked for in one request.
 */
function useUserList(request: AuthRequest): UserList {
  const [search, setSearch] = useState("")
  const [query, setQuery] = useState<UserQuery>({ filter: "", page: 0, filters: NO_USER_FILTERS })
  // Lower case because the server stores emails that way and matches them case sensitively.
  const settled = useDebouncedValue(userSearchTerm(search), SEARCH_DEBOUNCE_MS)
  useEffect(() => {
    setQuery((q) => (q.filter === settled ? q : { ...q, filter: settled, page: 0 }))
  }, [settled])
  const result = useApiQuery(() => fetchUserPage(request, query), [request, query])
  const setPage = useCallback((page: number) => setQuery((q) => ({ ...q, page })), [])
  const setFilters = useCallback((filters: UserFilters) => setQuery((q) => ({ ...q, filters, page: 0 })), [])
  return { ...result, search, setSearch, query, setPage, setFilters }
}

/** "Users 51-62 of 62". */
function userRangeText(page: UserPage): string {
  if (page.users.length === 0) return `0 of ${page.total} users`
  const first = page.page * USERS_PAGE_SIZE + 1
  return `Users ${first}-${first + page.users.length - 1} of ${page.total}`
}

/** The providers to filter by: those the project has switched on, or the common ones until it says. */
function providerChoices(external: Record<string, boolean> | undefined): string[] {
  const enabled = Object.entries(external ?? {}).filter(([name, on]) => on && name !== "anonymous_users").map(([name]) => name)
  return enabled.length > 0 ? enabled : providerFilters.slice(1)
}

export function AuthManagement(): React.ReactElement {
  // Rows here are read with the service role, so the elevated-access notice applies
  // to this view. See `useShowsProjectRows`.
  useShowsProjectRows()

  const client = useStudioClient()
  const studioMembers = useStudioMembers()
  const studioAccess = useStudioCapability()
  // Empty unless the viewer may manage members at all, so the control is absent rather than
  // offering a grant the server will refuse.
  const grantableStudioRoles = studioAccess.canManageMembers
    ? studioMembers.roles.map((r) => r.role)
    : []
  // The same reading the auth Configuration page shows, so the form's default cannot disagree with it.
  const { settings: authSettings } = useAuthSettings()
  // Whether the caller may change this user's account: not an admin's, unless the caller is one.
  const accountOffered = (userId: string): boolean =>
    adminAccountChangeOffered(studioAccess, studioMembers.roleFor(userId))
  // Whether the caller may disable or delete this account: one they may change, and not their own.
  const removalOffered = (userId: string): boolean =>
    accountOffered(userId) && accountRemovalOffered(studioAccess.userId, userId)
  const createOptions: CreateUserOptions = {
    studioRoles: grantableStudioRoles,
    autoConfirmDefault: authSettings?.mailer_autoconfirm ?? null,
  }

  // A 403 here is the Studio proxy refusing the role, said as the route's gate says it.
  const refused = useRoleRefusalText()
  /** One call to the auth server through Studio's proxy, which adds the service role key. */
  const authRequest = useCallback<AuthRequest>((path, options) => fetch(`${client.url}/auth/v1${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...studioAuthHeaders(client),
      ...options?.headers,
    },
    credentials: "include",
  }).then((res) => unlessRoleRefused(res, refused)), [client, refused])
  const authAdminRequest = useCallback<AuthRequest>(
    (path, options) => authRequest(`/admin${path}`, options),
    [authRequest],
  )
  const authFetch = useCallback(
    async <T,>(path: string, guard: Guard<T>, options?: RequestInit): Promise<T> =>
      readJson(await acceptedResponse(await authRequest(path, options)), guard),
    [authRequest],
  )
  const authAdminFetch = useCallback(
    <T,>(path: string, guard: Guard<T>, options?: RequestInit) => authFetch(`/admin${path}`, guard, options),
    [authFetch],
  )

  const { data: userPage, loading, error, refetch, search, setSearch, query, setPage, setFilters } = useUserList(authAdminRequest)
  const filters = query.filters

  const users = userPage?.users ?? []
  const [searchParams, setSearchParams] = useSearchParams()
  const userIdParam = searchParams.get("user")

  // Filters on the page on screen; the search box is the server's, in `useUserList`.

  // Panels
  const [selectedUser, setSelectedUser] = useState<AuthUser | null>(null)
  const selectedUserId = selectedUser?.id ?? null

  // The open user's sessions, asked of the auth admin API by user: it used to read every active
  // session in the project and keep that user's in the browser. Through the auth admin API, like
  // the rest of user administration, rather than the SQL editor's route, which is for different
  // roles and cannot touch the tables the auth service owns.
  const { data: sessionsData, refetch: refetchSessions } = useApiQuery(
    async () => {
      if (selectedUserId === null) return []
      const json = await authAdminFetch(`/users/${encodeURIComponent(selectedUserId)}/sessions`, isSessionList)
      return json.sessions.map(mapAuthSession)
    },
    [authAdminFetch, selectedUserId],
  )
  const sessions = sessionsData ?? []
  const [editingUser, setEditingUser] = useState<AuthUser | null>(null)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [showInviteForm, setShowInviteForm] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  /** Run one user action, showing the auth server's refusal rather than dropping it. */
  const runAction = useCallback((action: () => Promise<void>) => {
    setActionError(null)
    action().catch((err: unknown) => setActionError(err instanceof Error ? err.message : String(err)))
  }, [])

  const openUser = useCallback((u: AuthUser) => {
    setSelectedUser(u)
    setEditingUser(null)
    setShowCreateForm(false)
    setShowInviteForm(false)
    setSearchParams({ user: u.id }, { replace: true })
  }, [setSearchParams])

  useEffect(() => {
    if (!userIdParam) return
    const found = users.find((u) => u.id === userIdParam)
    if (found) {
      setSelectedUser(found)
      return
    }
    if (loading) return
    void authAdminFetch(`/users/${encodeURIComponent(userIdParam)}`, isAuthUserResponse)
      .then((raw) => setSelectedUser(mapAuthUser(raw)))
      .catch(() => {
        setSearchParams({}, { replace: true })
      })
  }, [userIdParam, users, loading, authAdminFetch, setSearchParams])

  // Filtering logic
  // Filtered by the server, across every user: the choices used to apply only to the page on screen.
  const filtered = users

  const handleToggleDisable = useCallback(async (userId: string) => {
    const user = users.find((u) => u.id === userId)
    if (!user) return
    const ban_duration = user.disabled ? "none" : "876000h"
    await authAdminFetch(`/users/${userId}`, isUnknown, {
      method: "PUT",
      body: JSON.stringify({ ban_duration }),
    })
    refetch()
    setSelectedUser(null)
  }, [users, authAdminFetch, refetch])

  const handleDeleteUser = useCallback(async (userId: string) => {
    await authAdminFetch(`/users/${userId}`, isUnknown, { method: "DELETE" })
    refetch()
    setSelectedUser(null)
  }, [authAdminFetch, refetch])

  const handleCreateUser = useCallback(async (data: UserFormData) => {
    const created = await authAdminFetch("/users", isCreatedUser, {
      method: "POST",
      body: JSON.stringify({
        email: data.email,
        password: data.password,
        user_metadata: data.metadata,
        role: data.role,
        email_confirm: data.emailConfirm ?? false,
      }),
    })

    // Two calls because they are two different things: the account lives in `auth.users`, the
    // Studio grant lives in `_supatype.studio_members`, and only the first is the auth service’s to create.
    // A failure here leaves a real user with no Studio access, which is the safe half to be left
    // holding: the alternative is a grant pointing at a user that does not exist.
    if (data.studioRole !== undefined && typeof created.id === "string") {
      await studioMembers.setRole(created.id, data.studioRole)
    }

    refetch()
    setShowCreateForm(false)
  }, [authAdminFetch, refetch, studioMembers])

  const handleConfirmEmail = useCallback(async (userId: string) => {
    const updated = await authAdminFetch(`/users/${encodeURIComponent(userId)}`, isAuthUserResponse, {
      method: "PUT",
      body: JSON.stringify({ email_confirm: true }),
    })
    setSelectedUser(mapAuthUser(updated))
    refetch()
  }, [authAdminFetch, refetch])

  const handleEditUser = useCallback(async (data: UserFormData) => {
    if (!editingUser) return
    await authAdminFetch(`/users/${editingUser.id}`, isUnknown, {
      method: "PUT",
      body: JSON.stringify({
        email: data.email,
        role: data.role,
        user_metadata: data.metadata,
        ...(data.password ? { password: data.password } : {}),
      }),
    })
    refetch()
    setEditingUser(null)
    setSelectedUser(null)
  }, [editingUser, authAdminFetch, refetch])

  // The invite endpoint, not admin user creation: only it mails the invitation link, and the user
  // it creates gets the server's default role, which is what the form shows. Sent without a
  // Referer: the server takes one as the link's redirect, which landed the invitee on this Studio
  // page. Without it the link goes to the project's site URL, the app.
  const handleInviteUser = useCallback(async (email: string) => {
    await authFetch("/invite", isUnknown, {
      method: "POST",
      body: JSON.stringify({ email }),
      referrerPolicy: "no-referrer",
    })
    refetch()
    setShowInviteForm(false)
  }, [authFetch, refetch])

  const handleRevokeSession = useCallback(async (sessionId: string) => {
    await authAdminFetch(`/sessions/${encodeURIComponent(sessionId)}`, isUnknown, { method: "DELETE" })
    refetchSessions()
  }, [authAdminFetch, refetchSessions])

  // Only before the first page arrives: a search or a page change keeps the list, and its search
  // box, on screen while the next one loads.
  if (loading && userPage === null) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
        Loading users…
      </div>
    )
  }

  if (error) {
    return <ErrorBanner message={error} onRetry={refetch} />
  }

  const panelOpen = selectedUser !== null || editingUser !== null || showCreateForm || showInviteForm
  // Shown inside the panel while it is open, since it covers the page. A user's detail says it
  // above its own actions instead.
  const actionBanner = actionError ? <div className="mb-4"><ErrorBanner message={actionError} /></div> : null
  const showingDetail = !editingUser && !showCreateForm && !showInviteForm
  const panelTitle = editingUser ? "Edit User"
    : showCreateForm ? "Create User"
    : showInviteForm ? "Invite User"
    : selectedUser?.email ?? ""
  const panelSubtitle = showingDetail
    ? selectedUser?.id
    : undefined

  function closePanel() {
    setSelectedUser(null)
    setEditingUser(null)
    setShowCreateForm(false)
    setShowInviteForm(false)
    setActionError(null)
    if (searchParams.has("user")) {
      const next = new URLSearchParams(searchParams)
      next.delete("user")
      setSearchParams(next, { replace: true })
    }
  }

  // A search or a choice that matches nobody is not an empty project: the list stays, saying so.
  const narrowed = query.filter !== "" || search.trim() !== "" || Object.keys(userFilterParams(filters)).length > 0
  if (userPage?.total === 0 && !narrowed && !panelOpen) {
    return (
      <EmptyState
        title="No users registered yet."
        description="Create a user to get started with authentication."
        action={() => setShowCreateForm(true)}
        actionLabel="Create User"
      />
    )
  }

  return (
    <>
      {/* Toolbar */}
      <div className="flex gap-2 mb-4 flex-wrap">
        <Input
          className="flex-1 min-w-[200px]"
          placeholder="Search by email, name, or ID..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select className="w-[140px]" value={filters.role} onChange={(e) => setFilters({ ...filters, role: e.target.value })}>
          <option value="all">All roles</option>
          {availableRoles.map((r) => <option key={r} value={r}>{r}</option>)}
        </Select>
        <Select className="w-[140px]" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
          <option value="all">All status</option>
          {statusFilters.slice(1).map((s) => <option key={s} value={s}>{s}</option>)}
        </Select>
        <Select className="w-[140px]" value={filters.provider} onChange={(e) => setFilters({ ...filters, provider: e.target.value })}>
          <option value="all">All providers</option>
          {providerChoices(authSettings?.external).map((p) => <option key={p} value={p}>{p}</option>)}
        </Select>
        <Button onClick={() => setShowInviteForm(true)}>Invite User</Button>
        <Button variant="primary" onClick={() => setShowCreateForm(true)}>+ Create User</Button>
      </div>

      {panelOpen ? null : actionBanner}

      {/* User list */}
      <Card className={loading ? "overflow-auto opacity-60 transition-opacity" : "overflow-auto"} aria-busy={loading}>
        <Table>
          <UserTableHead />
          <tbody>
            {filtered.map((u) => (
              <UserRow
                key={u.id}
                user={u}
                access={{ members: studioMembers, currentUserId: studioAccess.userId, canManage: studioAccess.canManageMembers }}
                actions={{
                  open: () => openUser(u),
                  toggle: removalOffered(u.id) ? () => runAction(() => handleToggleDisable(u.id)) : null,
                }}
              />
            ))}
            {filtered.length === 0 ? (
              <tr>
                <Td colSpan={10} className="text-center py-8 text-muted-foreground">
                  No users found
                </Td>
              </tr>
            ) : null}
          </tbody>
        </Table>
      </Card>

      {userPage ? (
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground mt-2">{userRangeText(userPage)}</span>
          {/* The page of the rows on screen, not the one being asked for: they differ while it loads. */}
          <Pager
            at={{ page: userPage.page, pageSize: USERS_PAGE_SIZE, total: userPage.total }}
            onPage={setPage}
            busy={loading}
          />
        </div>
      ) : null}

      <SlidePanel
        open={panelOpen}
        onClose={closePanel}
        title={panelTitle}
        subtitle={panelSubtitle}
        width="max-w-[560px]"
      >
        {showingDetail ? null : actionBanner}
        {selectedUser && showingDetail && (
          <UserDetail
            user={selectedUser}
            sessions={sessions}
            actions={{
              account: accountOffered(selectedUser.id) ? {
                onToggleDisable: removalOffered(selectedUser.id) ? () => runAction(() => handleToggleDisable(selectedUser.id)) : null,
                onEdit: () => setEditingUser(selectedUser),
                onDelete: removalOffered(selectedUser.id) ? () => runAction(() => handleDeleteUser(selectedUser.id)) : null,
                onRevokeSession: (id) => runAction(() => handleRevokeSession(id)),
              } : null,
              // Both hosts gate the whole auth admin API on `manageUsers`.
              onConfirmEmail: userAdministrationOffered(studioAccess)
                ? () => runAction(() => handleConfirmEmail(selectedUser.id))
                : undefined,
              refusal: actionError,
            }}
          />
        )}
        {editingUser && (
          <UserForm
            user={editingUser}
            onSave={(data) => runAction(() => handleEditUser(data))}
            onCancel={() => setEditingUser(null)}
          />
        )}
        {showCreateForm && (
          <UserForm
            user={null}
            create={createOptions}
            onSave={(data) => runAction(() => handleCreateUser(data))}
            onCancel={() => setShowCreateForm(false)}
          />
        )}
        {showInviteForm && (
          <InviteUserForm
            onInvite={(email) => runAction(() => handleInviteUser(email))}
            onCancel={() => setShowInviteForm(false)}
          />
        )}
      </SlidePanel>
    </>
  )
}
