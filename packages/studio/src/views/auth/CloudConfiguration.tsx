import React from "react"
import { ErrorBanner } from "../../components/ErrorBanner.js"
import { Badge, Card, Table, Th } from "../../components/ui.js"
import type { AuthSettingsView } from "../../hooks/useCloudAuthSettings.js"
import { SettingsLoading } from "./AuthSettingsTable.js"
import {
  AppliedBadge,
  fieldOf,
  SecretRow,
  SettingRow,
  useCloudAuthEditor,
  type CloudAuthEditor,
  type SettingSpec,
} from "./CloudAuthParts.js"

/**
 * The environment's auth configuration on Cloud, read and saved through the control plane. A value
 * saved here wins over the one `supatype push` sent, and says so until it is reset.
 */

const MAIL_PROVIDERS = ["console", "smtp", "resend", "ses"] as const

function accessSpecs(view: AuthSettingsView): SettingSpec[] {
  return [
    { path: "auth.siteUrl", label: "Site URL", kind: "text" },
    { path: "auth.redirectUrls", label: "Redirect allow list", kind: "list", fixed: view.platformRedirectUrls },
    { path: "auth.disableSignup", label: "Sign-ups disabled", kind: "bool" },
    { path: "auth.email.enabled", label: "Email sign-in", kind: "bool" },
    { path: "auth.email.enableConfirmations", label: "Email confirmations", kind: "bool" },
  ]
}

const SMTP_SPECS: SettingSpec[] = [
  { path: "email.smtp.host", label: "SMTP host", kind: "text" },
  { path: "email.smtp.port", label: "SMTP port", kind: "number" },
  { path: "email.smtp.user", label: "SMTP user", kind: "text" },
  { path: "email.smtp.admin_email", label: "SMTP admin email", kind: "text" },
  { path: "email.smtp.sender_name", label: "SMTP sender name", kind: "text" },
]

/** The mail fields the chosen provider reads, after the provider choice itself. */
function mailSpecs(provider: string | null): SettingSpec[] {
  const choice: SettingSpec = { path: "email.provider", label: "Mail provider", kind: "select", options: MAIL_PROVIDERS }
  if (provider === "smtp") return [choice, ...SMTP_SPECS]
  if (provider === "resend") return [choice, { path: "email.resend_from", label: "Resend from address", kind: "text" }]
  if (provider === "ses") return [choice, { path: "email.ses_from", label: "SES from address", kind: "text" }]
  return [choice]
}

function mailSecretRow(provider: string | null, editor: CloudAuthEditor): React.ReactElement | null {
  if (provider === "smtp") return <SecretRow secretKey="email.smtp.pass" label="SMTP password" editor={editor} />
  if (provider === "resend") return <SecretRow secretKey="email.resend_api_key" label="Resend API key" editor={editor} />
  return null
}

function SpecTable({ title, specs, view, editor, children }: { title: string; specs: SettingSpec[]; view: AuthSettingsView; editor: CloudAuthEditor; children?: React.ReactNode }): React.ReactElement {
  return (
    <Card>
      <h3 className="text-sm font-medium text-foreground px-4 pt-4 pb-2">{title}</h3>
      <div className="overflow-x-auto">
        <Table>
          <thead>
            <tr className="border-b border-border bg-muted/40">
              <Th className="px-4 py-2.5">Setting</Th>
              <Th className="px-4 py-2.5">Value</Th>
              <Th className="px-4 py-2.5">Source</Th>
            </tr>
          </thead>
          <tbody>
            {specs.map((spec) => <SettingRow key={spec.path} spec={spec} field={fieldOf(view, spec.path)} editor={editor} />)}
            {children}
          </tbody>
        </Table>
      </div>
    </Card>
  )
}

function PlatformSenderNotice({ view }: { view: AuthSettingsView }): React.ReactElement {
  return (
    <p className="text-sm text-muted-foreground">
      Mail is sent through the platform sender until you choose a provider of your own.
      {view.mailHourlyCap !== null ? ` It is limited to ${view.mailHourlyCap} emails per hour for this environment.` : ""}
    </p>
  )
}

function Mail({ view, editor }: { view: AuthSettingsView; editor: CloudAuthEditor }): React.ReactElement {
  const chosen = fieldOf(view, "email.provider").value
  const provider = typeof chosen === "string" ? chosen : null
  return (
    <div className="space-y-3">
      {view.platformSender ? <PlatformSenderNotice view={view} /> : null}
      <SpecTable title="Email delivery" specs={mailSpecs(provider)} view={view} editor={editor}>
        {mailSecretRow(provider, editor)}
      </SpecTable>
    </div>
  )
}

export function CloudConfiguration({ environment }: { environment: string }): React.ReactElement {
  const editor = useCloudAuthEditor(environment)
  const { view } = editor
  return (
    <div className="space-y-5 max-w-3xl">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold text-foreground">Configuration</h1>
        <Badge variant="outline">{environment}</Badge>
        {view !== null ? <AppliedBadge view={view} /> : null}
      </div>
      <p className="text-sm text-muted-foreground">
        A value saved here wins over supatype.config.ts for this environment until you reset it.
        {editor.canEdit ? "" : " Your role can read these settings but not change them."}
      </p>
      {editor.error !== null ? <ErrorBanner message={editor.error} /> : null}
      {editor.loading && view === null ? <SettingsLoading /> : null}
      {view !== null ? <SpecTable title="Sign-up and sign-in" specs={accessSpecs(view)} view={view} editor={editor} /> : null}
      {view !== null ? <Mail view={view} editor={editor} /> : null}
    </div>
  )
}
