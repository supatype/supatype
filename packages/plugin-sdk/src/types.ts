/**
 * Core plugin system types for @supatype/plugin-sdk.
 *
 * Every Supatype plugin is an npm package that exports one or more of:
 *   - Field type definitions (defineFieldType)
 *   - Composite definitions (defineComposite)
 *   - Provider implementations (defineProvider)
 *   - Widget definitions (defineWidget)
 */

// ─── Plugin Metadata ─────────────────────────────────────────────────────────

/** Plugin API version — used for compatibility checking. */
export const PLUGIN_API_VERSION = 1

export type PluginType = "field" | "composite" | "provider" | "widget"

export interface PluginMeta {
  /** Plugin name (npm package name) */
  name: string
  /** Human-readable description */
  description: string
  /** Plugin type(s) */
  types: PluginType[]
  /** Plugin API version this plugin targets */
  pluginApi: number
  /** Minimum compatible Supatype version (semver) */
  supatypeVersion?: string | undefined
}

// ─── Field Type Plugin ───────────────────────────────────────────────────────

export interface FieldTypeDefinition<TValue = unknown> {
  /** Unique field type name (e.g., "phone", "currency", "slug") */
  name: string
  /** Postgres column type (e.g., "TEXT", "JSONB", "INTEGER") */
  pgType: string
  /** TypeScript type string for code generation (e.g., "string", "number", "PhoneNumber") */
  tsType: string
  /** Optional default value expression */
  defaultExpression?: string | undefined
  /** Validate a value — return null if valid, error message if invalid */
  validate?(value: unknown): string | null
  /** Serialise a TypeScript value to a Postgres-compatible value */
  serialise?(value: TValue): unknown
  /** Deserialise a Postgres value to a TypeScript value */
  deserialise?(raw: unknown): TValue
  /** Supported filter operators (default: eq, neq, in) */
  filterOperators?: string[] | undefined
  /** Path to React widget component (relative to plugin package root) */
  widgetPath?: string | undefined
  /** Additional Postgres constraints (e.g., CHECK expressions) */
  constraints?: string[] | undefined
  /** Plugin metadata */
  meta?: PluginMeta | undefined
}

// ─── Composite Plugin ────────────────────────────────────────────────────────

export interface CompositeFieldDef {
  /** Field name */
  name: string
  /** Built-in or plugin field type */
  type: string
  /** Whether the field is required */
  required?: boolean | undefined
  /** Default value */
  defaultValue?: unknown | undefined
  /** Additional field options */
  options?: Record<string, unknown> | undefined
}

export interface CompositeDefinition {
  /** Unique composite name (e.g., "seo", "address", "social-links") */
  name: string
  /** Human-readable label for the admin panel */
  label: string
  /** Fields this composite adds to a model */
  fields: CompositeFieldDef[]
  /** Admin panel grouping — how fields should be displayed */
  adminGroup?: {
    /** Collapsible group? Default: true */
    collapsible?: boolean | undefined
    /** Default collapsed state? Default: false */
    defaultCollapsed?: boolean | undefined
  } | undefined
  /** SQL to execute when the composite is first applied (e.g., trigger creation) */
  installSQL?: string | undefined
  /** SQL to execute when the composite is removed */
  uninstallSQL?: string | undefined
  /** Plugin metadata */
  meta?: PluginMeta | undefined
}

// ─── Provider Plugin ─────────────────────────────────────────────────────────

export type ProviderCategory =
  | "commerce"
  | "tracking"
  | "email"
  | "storage"
  | "auth"
  | "ssl"
  | "ai"
  | "search"
  | "push-notification"

export interface ProviderDefinition<TConfig = Record<string, unknown>> {
  /** Unique provider name (e.g., "stripe", "posthog", "resend") */
  name: string
  /** Provider category */
  category: ProviderCategory
  /** Human-readable label */
  label: string
  /** Configuration schema — used for validation and Studio settings UI */
  configSchema: Record<string, {
    type: "string" | "number" | "boolean" | "select"
    label: string
    required?: boolean | undefined
    default?: unknown | undefined
    options?: string[] | undefined
    secret?: boolean | undefined
  }>
  /** Create a provider instance from config */
  create(config: TConfig): unknown
  /** Plugin metadata */
  meta?: PluginMeta | undefined
}

// ─── Commerce Provider ───────────────────────────────────────────────────────

export interface CommerceProvider {
  /** Create or sync a product */
  syncProduct(product: {
    id: string
    name: string
    description?: string | undefined
    active: boolean
    prices: Array<{ amount: number; currency: string; interval?: string | undefined }>
  }): Promise<{ externalId: string }>

  /** Create a checkout session */
  createCheckout(params: {
    customerId?: string | undefined
    lineItems: Array<{ priceId: string; quantity: number }>
    successUrl: string
    cancelUrl: string
    metadata?: Record<string, string> | undefined
  }): Promise<{ url: string; sessionId: string }>

  /** Create a subscription */
  createSubscription?(params: {
    customerId: string
    priceId: string
    metadata?: Record<string, string> | undefined
  }): Promise<{ subscriptionId: string; status: string }>

  /** Cancel a subscription */
  cancelSubscription?(subscriptionId: string): Promise<void>

  /** Create a customer portal URL */
  getPortalUrl?(customerId: string, returnUrl: string): Promise<string>

  /** Handle a webhook payload — returns the parsed event */
  handleWebhook(payload: string, signature: string): Promise<{ type: string; data: unknown }>
}

// ─── Tracking Provider ───────────────────────────────────────────────────────

export interface TrackingProvider {
  /** Capture an event */
  capture(event: {
    distinctId: string
    eventName: string
    properties?: Record<string, unknown> | undefined
    timestamp?: Date | undefined
  }): Promise<void>

  /** Identify a user */
  identify(params: {
    distinctId: string
    properties: Record<string, unknown>
  }): Promise<void>

  /** Identify a group */
  groupIdentify?(params: {
    groupType: string
    groupKey: string
    properties: Record<string, unknown>
  }): Promise<void>

  /** Evaluate a feature flag */
  getFeatureFlag?(params: {
    key: string
    distinctId: string
    properties?: Record<string, unknown> | undefined
  }): Promise<boolean | string>
}

// ─── Email Provider ──────────────────────────────────────────────────────────

export interface EmailProvider {
  /** Send a single email */
  send(params: {
    to: string | string[]
    subject: string
    html?: string | undefined
    text?: string | undefined
    from?: string | undefined
    replyTo?: string | undefined
    headers?: Record<string, string> | undefined
  }): Promise<{ messageId: string }>

  /** Send using a template */
  sendTemplate?(params: {
    to: string | string[]
    templateId: string
    data: Record<string, unknown>
    from?: string | undefined
  }): Promise<{ messageId: string }>

  /** Send batch emails */
  sendBatch?(messages: Array<{
    to: string
    subject: string
    html?: string | undefined
    text?: string | undefined
  }>): Promise<{ messageIds: string[] }>
}

// ─── Storage Provider ────────────────────────────────────────────────────────

export interface StorageProvider {
  /** Upload a file */
  upload(params: {
    bucket: string
    path: string
    body: Uint8Array | ReadableStream
    contentType?: string | undefined
    metadata?: Record<string, string> | undefined
  }): Promise<{ key: string; size: number }>

  /** Download a file */
  download(params: {
    bucket: string
    path: string
  }): Promise<{ body: ReadableStream; contentType: string; size: number }>

  /** Delete a file */
  delete(params: { bucket: string; path: string }): Promise<void>

  /** List files in a path */
  list(params: {
    bucket: string
    prefix?: string | undefined
    limit?: number | undefined
    cursor?: string | undefined
  }): Promise<{ items: Array<{ key: string; size: number; lastModified: Date }>; cursor?: string | undefined }>

  /** Generate a pre-signed URL */
  getSignedUrl(params: {
    bucket: string
    path: string
    expiresIn: number
    operation?: "read" | "write" | undefined
  }): Promise<string>
}

// ─── Auth Provider ───────────────────────────────────────────────────────────

export interface AuthProvider {
  /** Sign up with email/password */
  signUp(params: {
    email: string
    password: string
    metadata?: Record<string, unknown> | undefined
  }): Promise<{ userId: string; session?: { accessToken: string; refreshToken: string } | undefined }>

  /** Sign in with email/password */
  signIn(params: {
    email: string
    password: string
  }): Promise<{ userId: string; session: { accessToken: string; refreshToken: string } }>

  /** Sign out */
  signOut(accessToken: string): Promise<void>

  /** Refresh a session */
  refreshSession(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }>

  /** Get user by access token */
  getUser(accessToken: string): Promise<{
    id: string
    email?: string | undefined
    metadata: Record<string, unknown>
  } | null>
}

// ─── SSL Provider ────────────────────────────────────────────────────────────

export interface SSLProvider {
  /** Provision a certificate for a domain */
  provision(domain: string): Promise<{ status: "provisioning" | "active" | "error"; message?: string | undefined }>

  /** Check certificate status */
  checkStatus(domain: string): Promise<{ status: "provisioning" | "active" | "expired" | "error"; expiresAt?: Date | undefined }>

  /** Renew a certificate */
  renew(domain: string): Promise<{ status: string }>
}

// ─── Widget Plugin ───────────────────────────────────────────────────────────

export interface WidgetDefinition {
  /** Unique widget name (e.g., "color-picker", "markdown-editor", "rating-stars") */
  name: string
  /** Human-readable label */
  label: string
  /** Compatible field types this widget can be assigned to (e.g., ["text", "varchar"]) */
  compatibleTypes: string[]
  /** Path to React component (relative to plugin package root) */
  componentPath: string
  /** Optional widget configuration schema */
  configSchema?: Record<string, {
    type: "string" | "number" | "boolean" | "select"
    label: string
    default?: unknown | undefined
  }> | undefined
  /** Plugin metadata */
  meta?: PluginMeta | undefined
}

/** Props passed to widget React components */
export interface WidgetProps<TValue = unknown> {
  value: TValue | null
  onChange: (value: TValue | null) => void
  fieldName: string
  fieldType: string
  config: Record<string, unknown>
  errors: string[]
  disabled?: boolean | undefined
  placeholder?: string | undefined
}
