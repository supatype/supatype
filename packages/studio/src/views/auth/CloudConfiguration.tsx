import React from "react"
import { groupRequiredSecretKeys } from "@supatype/types"
import type { AuthSettingsView } from "../../hooks/useCloudAuthSettings.js"
import {
  CloudAuthPage,
  fieldOf,
  SecretRow,
  SpecTable,
  useCloudAuthEditor,
  usePendingChoice,
  type CloudAuthEditor,
  type PendingChoiceSpec,
  type SettingSpec,
} from "./CloudAuthParts.js"
import { CloudAuthSections } from "./CloudAuthSections.js"

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
  if (provider === "ses") {
    return [
      choice,
      { path: "email.ses_from", label: "SES from address", kind: "text" },
      { path: "email.ses_region", label: "SES region", kind: "text" },
    ]
  }
  return [choice]
}

function mailSecretRow(provider: string | null, editor: CloudAuthEditor): React.ReactElement | null {
  if (provider === "smtp") return <SecretRow secretKey="email.smtp.pass" label="SMTP password" editor={editor} />
  if (provider === "resend") return <SecretRow secretKey="email.resend_api_key" label="Resend API key" editor={editor} />
  if (provider === "ses") {
    return (
      <>
        <SecretRow secretKey="email.ses_access_key_id" label="SES access key ID" editor={editor} />
        <SecretRow secretKey="email.ses_secret_access_key" label="SES secret access key" editor={editor} />
      </>
    )
  }
  return null
}

function PlatformSenderNotice({ view }: { view: AuthSettingsView }): React.ReactElement {
  return (
    <p className="text-sm text-muted-foreground">
      Mail is sent through the platform sender until you choose a provider of your own.
      {view.mailHourlyCap !== null ? ` It is limited to ${view.mailHourlyCap} emails per hour for this environment.` : ""}
    </p>
  )
}

/** SES is refused until both its keys exist, so choosing it waits for them (see usePendingChoice). */
const MAIL_CHOICE: PendingChoiceSpec = {
  path: "email.provider",
  secretKeys: (choice) => {
    const provider = MAIL_PROVIDERS.find((name) => name === choice)
    return provider === undefined ? [] : groupRequiredSecretKeys({ email: { provider } })
  },
}

const SES_NOTE = "Enter both keys: they are saved together with the provider."

function Mail({ editor }: { editor: CloudAuthEditor }): React.ReactElement | null {
  const mail = usePendingChoice(editor, MAIL_CHOICE)
  const { view } = mail
  if (view === null) return null
  const chosen = fieldOf(view, MAIL_CHOICE.path).value
  const provider = typeof chosen === "string" ? chosen : null
  return (
    <div className="space-y-3">
      {view.platformSender ? <PlatformSenderNotice view={view} /> : null}
      <SpecTable title="Email delivery" specs={mailSpecs(provider)} editor={mail} {...(provider === "ses" && { note: SES_NOTE })}>
        {mailSecretRow(provider, mail)}
      </SpecTable>
    </div>
  )
}

const INTRO = "A value saved here wins over supatype.config.ts for this environment until you reset it."

export function CloudConfiguration({ environment }: { environment: string }): React.ReactElement {
  const editor = useCloudAuthEditor(environment)
  const { view } = editor
  return (
    <CloudAuthPage title="Configuration" environment={environment} intro={INTRO} editor={editor}>
      {view !== null ? <SpecTable title="Sign-up and sign-in" specs={accessSpecs(view)} editor={editor} /> : null}
      {view !== null ? <Mail editor={editor} /> : null}
      <CloudAuthSections editor={editor} />
    </CloudAuthPage>
  )
}
