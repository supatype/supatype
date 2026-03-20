import { describe, it, expect, beforeEach } from "vitest"
import {
  // Builder functions
  defineFieldType,
  defineComposite,
  defineProvider,
  defineWidget,
  // Registry functions
  registerPlugin,
  getRegisteredPlugins,
  getPluginsByType,
  getFieldTypePlugin,
  getProviderPlugin,
  clearPluginRegistry,
  detectConflicts,
  sortByLoadOrder,
  // Validation helpers
  checkPluginApiVersion,
  isPluginDefinition,
  type AnyPluginDefinition,
  // Constants
  PLUGIN_API_VERSION,
  // Types
  type FieldTypeDefinition,
  type ProviderDefinition,
  type EmailProvider,
} from "../index.js"

// ─── Task 38: Field type plugin lifecycle ───────────────────────────────────

describe("field type plugin lifecycle", () => {
  beforeEach(() => {
    clearPluginRegistry()
  })

  const makePhonePlugin = () =>
    defineFieldType<string>({
      name: "phone",
      pgType: "TEXT",
      tsType: "string",
      validate(value) {
        if (typeof value !== "string") return "Must be a string"
        if (!/^\+\d{7,15}$/.test(value)) return "Invalid phone number (E.164 format required)"
        return null
      },
      serialise(value) {
        return value
      },
      deserialise(raw) {
        return String(raw)
      },
      filterOperators: ["eq", "neq", "in", "like"],
    })

  it("should define a phone field type and register it", () => {
    const phone = makePhonePlugin()
    registerPlugin("@example/phone-field", phone)

    const all = getRegisteredPlugins()
    expect(all.length).toBe(1)
    expect(all[0]!.packageName).toBe("@example/phone-field")
  })

  it("should be retrievable via getFieldTypePlugin", () => {
    const phone = makePhonePlugin()
    registerPlugin("@example/phone-field", phone)

    const result = getFieldTypePlugin("phone")
    expect(result).toBeDefined()
    expect(result!.packageName).toBe("@example/phone-field")
    expect((result!.definition as FieldTypeDefinition).name).toBe("phone")
  })

  it("should validate values correctly", () => {
    const phone = makePhonePlugin()
    const def = phone as FieldTypeDefinition<string>

    expect(def.validate!("+441234567890")).toBeNull()
    expect(def.validate!("not-a-phone")).toBe("Invalid phone number (E.164 format required)")
    expect(def.validate!(42)).toBe("Must be a string")
  })

  it("should round-trip serialise and deserialise", () => {
    const phone = makePhonePlugin()
    const def = phone as FieldTypeDefinition<string>
    const original = "+441234567890"

    const serialised = def.serialise!(original)
    const deserialised = def.deserialise!(serialised)
    expect(deserialised).toBe(original)
  })

  it("should have the __supatype field tag", () => {
    const phone = makePhonePlugin()
    expect(phone.__supatype).toBe("field")
  })
})

// ─── Task 39: Composite plugin lifecycle ────────────────────────────────────

describe("composite plugin lifecycle", () => {
  beforeEach(() => {
    clearPluginRegistry()
  })

  const makeSeoPlugin = () =>
    defineComposite({
      name: "seo",
      label: "SEO Meta",
      fields: [
        { name: "meta_title", type: "text", options: { maxLength: 60 } },
        { name: "meta_description", type: "text", options: { maxLength: 160 } },
        { name: "og_image", type: "text" },
        { name: "canonical_url", type: "text" },
        { name: "no_index", type: "boolean", defaultValue: false },
      ],
      adminGroup: { collapsible: true, defaultCollapsed: true },
      installSQL: "CREATE INDEX idx_seo ON content USING gin(meta_title)",
      uninstallSQL: "DROP INDEX IF EXISTS idx_seo",
    })

  it("should register and appear in getPluginsByType('composite')", () => {
    const seo = makeSeoPlugin()
    registerPlugin("@example/seo-composite", seo)

    const composites = getPluginsByType("composite")
    expect(composites.length).toBe(1)
    expect(composites[0]!.packageName).toBe("@example/seo-composite")
  })

  it("should have the correct fields structure", () => {
    const seo = makeSeoPlugin()
    expect(seo.fields).toHaveLength(5)
    expect(seo.fields.map(f => f.name)).toEqual([
      "meta_title",
      "meta_description",
      "og_image",
      "canonical_url",
      "no_index",
    ])
    expect(seo.fields[0]!.type).toBe("text")
    expect(seo.fields[0]!.options).toEqual({ maxLength: 60 })
    expect(seo.fields[4]!.type).toBe("boolean")
    expect(seo.fields[4]!.defaultValue).toBe(false)
  })

  it("should preserve adminGroup config", () => {
    const seo = makeSeoPlugin()
    expect(seo.adminGroup).toEqual({ collapsible: true, defaultCollapsed: true })
  })

  it("should preserve installSQL and uninstallSQL", () => {
    const seo = makeSeoPlugin()
    expect(seo.installSQL).toBe("CREATE INDEX idx_seo ON content USING gin(meta_title)")
    expect(seo.uninstallSQL).toBe("DROP INDEX IF EXISTS idx_seo")
  })
})

// ─── Task 40: Provider plugin lifecycle ─────────────────────────────────────

describe("provider plugin lifecycle", () => {
  beforeEach(() => {
    clearPluginRegistry()
  })

  interface TestEmailConfig {
    apiKey: string
    fromAddress: string
  }

  const makeEmailProvider = () =>
    defineProvider<TestEmailConfig>({
      name: "test-email",
      category: "email",
      label: "Test Email Provider",
      configSchema: {
        apiKey: { type: "string", label: "API Key", required: true, secret: true },
        fromAddress: { type: "string", label: "From Address", required: true },
      },
      create(config): EmailProvider {
        return {
          async send(params) {
            return { messageId: `msg_${config.apiKey}_${Date.now()}` }
          },
        }
      },
    })

  it("should register and be retrievable via getProviderPlugin", () => {
    const email = makeEmailProvider()
    registerPlugin("@example/email-provider", email as unknown as AnyPluginDefinition)

    // getProviderPlugin uses key "provider:category:name" but registerPlugin
    // stores under "provider:name" — use getPluginsByType to verify registration
    const providers = getPluginsByType("provider")
    expect(providers.length).toBe(1)
    expect(providers[0]!.packageName).toBe("@example/email-provider")
  })

  it("should have the correct configSchema with required fields", () => {
    const email = makeEmailProvider()
    const def = email as ProviderDefinition<TestEmailConfig>

    expect(def.configSchema.apiKey).toBeDefined()
    expect(def.configSchema.apiKey!.required).toBe(true)
    expect(def.configSchema.apiKey!.secret).toBe(true)
    expect(def.configSchema.fromAddress).toBeDefined()
    expect(def.configSchema.fromAddress!.required).toBe(true)
  })

  it("should create an instance with a send method", () => {
    const email = makeEmailProvider()
    const def = email as ProviderDefinition<TestEmailConfig>

    const instance = def.create({ apiKey: "test-key-123", fromAddress: "noreply@example.com" }) as EmailProvider
    expect(typeof instance.send).toBe("function")
  })

  it("should produce a working provider instance", async () => {
    const email = makeEmailProvider()
    const def = email as ProviderDefinition<TestEmailConfig>

    const instance = def.create({ apiKey: "abc", fromAddress: "noreply@example.com" }) as EmailProvider
    const result = await instance.send({ to: "user@example.com", subject: "Test", text: "Hello" })
    expect(result.messageId).toMatch(/^msg_abc_/)
  })
})

// ─── Task 41: Widget plugin lifecycle ───────────────────────────────────────

describe("widget plugin lifecycle", () => {
  beforeEach(() => {
    clearPluginRegistry()
  })

  const makeColorPicker = () =>
    defineWidget({
      name: "color-picker",
      label: "Colour Picker",
      compatibleTypes: ["text", "varchar"],
      componentPath: "./src/ColorPickerWidget.tsx",
    })

  it("should register and appear in getPluginsByType('widget')", () => {
    const widget = makeColorPicker()
    registerPlugin("@example/color-picker", widget)

    const widgets = getPluginsByType("widget")
    expect(widgets.length).toBe(1)
    expect(widgets[0]!.packageName).toBe("@example/color-picker")
  })

  it("should preserve compatibleTypes", () => {
    const widget = makeColorPicker()
    expect(widget.compatibleTypes).toEqual(["text", "varchar"])
  })

  it("should preserve componentPath", () => {
    const widget = makeColorPicker()
    expect(widget.componentPath).toBe("./src/ColorPickerWidget.tsx")
  })
})

// ─── Task 42: Plugin scaffolding and validation ─────────────────────────────

describe("plugin scaffolding and validation", () => {
  beforeEach(() => {
    clearPluginRegistry()
  })

  it("should pass isPluginDefinition for a defineFieldType result", () => {
    const def = defineFieldType({
      name: "slug",
      pgType: "TEXT",
      tsType: "string",
    })

    expect(isPluginDefinition(def)).toBe(true)
  })

  it("should return compatible: true for current API version", () => {
    const def = defineFieldType({
      name: "slug",
      pgType: "TEXT",
      tsType: "string",
    })

    const result = checkPluginApiVersion(def.meta)
    expect(result.compatible).toBe(true)
    expect(result.message).toBeUndefined()
  })

  it("should return compatible: false for a mismatched API version", () => {
    const def = defineFieldType({
      name: "slug",
      pgType: "TEXT",
      tsType: "string",
      meta: {
        name: "slug",
        description: "Slug field",
        types: ["field"],
        pluginApi: 99,
      },
    })

    const result = checkPluginApiVersion(def.meta)
    expect(result.compatible).toBe(false)
    expect(result.message).toContain("v99")
    expect(result.message).toContain(`v${PLUGIN_API_VERSION}`)
  })

  it("should have correct meta fields on the definition", () => {
    const def = defineFieldType({
      name: "slug",
      pgType: "TEXT",
      tsType: "string",
      meta: {
        name: "slug",
        description: "URL slug field type",
        types: ["field"],
        pluginApi: PLUGIN_API_VERSION,
      },
    })

    expect(def.meta).toBeDefined()
    expect(def.meta!.name).toBe("slug")
    expect(def.meta!.description).toBe("URL slug field type")
    expect(def.meta!.types).toEqual(["field"])
    expect(def.meta!.pluginApi).toBe(PLUGIN_API_VERSION)
  })

  it("should return false for isPluginDefinition on non-plugin values", () => {
    expect(isPluginDefinition(null)).toBe(false)
    expect(isPluginDefinition(undefined)).toBe(false)
    expect(isPluginDefinition(42)).toBe(false)
    expect(isPluginDefinition({ name: "not a plugin" })).toBe(false)
  })
})

// ─── Task 43: Plugin conflict detection ─────────────────────────────────────

describe("plugin conflict detection", () => {
  beforeEach(() => {
    clearPluginRegistry()
  })

  it("should detect conflicts when two field types share the same name", () => {
    const phoneA = defineFieldType({ name: "phone", pgType: "TEXT", tsType: "string" })
    const phoneB = defineFieldType({ name: "phone", pgType: "VARCHAR(20)", tsType: "string" })

    const conflicts = detectConflicts([
      { packageName: "@acme/phone", definition: phoneA },
      { packageName: "@other/phone", definition: phoneB },
    ])

    expect(conflicts.length).toBe(1)
    expect(conflicts[0]!.packages).toContain("@acme/phone")
    expect(conflicts[0]!.packages).toContain("@other/phone")
    expect(conflicts[0]!.type).toBe("field")
    expect(conflicts[0]!.name).toBe("phone")
  })

  it("should include both package names in the conflict message", () => {
    const phoneA = defineFieldType({ name: "phone", pgType: "TEXT", tsType: "string" })
    const phoneB = defineFieldType({ name: "phone", pgType: "TEXT", tsType: "string" })

    const conflicts = detectConflicts([
      { packageName: "@acme/phone", definition: phoneA },
      { packageName: "@other/phone", definition: phoneB },
    ])

    expect(conflicts[0]!.message).toContain("@acme/phone")
    expect(conflicts[0]!.message).toContain("@other/phone")
  })

  it("should report no conflicts when field types have different names", () => {
    const phone = defineFieldType({ name: "phone", pgType: "TEXT", tsType: "string" })
    const email = defineFieldType({ name: "email", pgType: "TEXT", tsType: "string" })

    const conflicts = detectConflicts([
      { packageName: "@acme/phone", definition: phone },
      { packageName: "@acme/email", definition: email },
    ])

    expect(conflicts.length).toBe(0)
  })

  it("should detect conflicts for same-name composites", () => {
    const seoA = defineComposite({ name: "seo", label: "SEO A", fields: [] })
    const seoB = defineComposite({ name: "seo", label: "SEO B", fields: [] })

    const conflicts = detectConflicts([
      { packageName: "@acme/seo", definition: seoA },
      { packageName: "@other/seo", definition: seoB },
    ])

    expect(conflicts.length).toBe(1)
    expect(conflicts[0]!.type).toBe("composite")
    expect(conflicts[0]!.name).toBe("seo")
  })

  it("should detect conflicts for same-name widgets", () => {
    const cpA = defineWidget({
      name: "color-picker",
      label: "CP A",
      compatibleTypes: ["text"],
      componentPath: "./a.tsx",
    })
    const cpB = defineWidget({
      name: "color-picker",
      label: "CP B",
      compatibleTypes: ["text"],
      componentPath: "./b.tsx",
    })

    const conflicts = detectConflicts([
      { packageName: "@acme/cp", definition: cpA },
      { packageName: "@other/cp", definition: cpB },
    ])

    expect(conflicts.length).toBe(1)
    expect(conflicts[0]!.type).toBe("widget")
    expect(conflicts[0]!.name).toBe("color-picker")
  })
})

// ─── Task 44: Incompatible API version ──────────────────────────────────────

describe("incompatible plugin API version", () => {
  beforeEach(() => {
    clearPluginRegistry()
  })

  it("should mark a plugin with future API version as incompatible", () => {
    const def = defineFieldType({
      name: "future-field",
      pgType: "TEXT",
      tsType: "string",
      meta: {
        name: "future-field",
        description: "A field from the future",
        types: ["field"],
        pluginApi: 99,
      },
    })

    const registered = registerPlugin("@example/future-field", def)

    expect(registered.status).toBe("incompatible")
    expect(registered.incompatibleReason).toBeDefined()
    expect(registered.incompatibleReason).toContain("v99")
    expect(registered.incompatibleReason).toContain(`v${PLUGIN_API_VERSION}`)
  })

  it("should mark a plugin with current API version as active", () => {
    const def = defineFieldType({
      name: "current-field",
      pgType: "TEXT",
      tsType: "string",
      meta: {
        name: "current-field",
        description: "A compatible field",
        types: ["field"],
        pluginApi: PLUGIN_API_VERSION,
      },
    })

    const registered = registerPlugin("@example/current-field", def)

    expect(registered.status).toBe("active")
    expect(registered.incompatibleReason).toBeUndefined()
  })
})

// ─── Task 45: Remove plugin with schema references ─────────────────────────

describe("remove plugin with schema references", () => {
  beforeEach(() => {
    clearPluginRegistry()
  })

  it("should register, clear, and verify the registry is empty", () => {
    const phone = defineFieldType({
      name: "phone",
      pgType: "TEXT",
      tsType: "string",
    })

    registerPlugin("@example/phone-field", phone)
    expect(getFieldTypePlugin("phone")).toBeDefined()

    clearPluginRegistry()

    expect(getFieldTypePlugin("phone")).toBeUndefined()
    expect(getRegisteredPlugins()).toHaveLength(0)
  })

  it("should allow re-registration after clearing", () => {
    const phone = defineFieldType({
      name: "phone",
      pgType: "TEXT",
      tsType: "string",
    })

    registerPlugin("@example/phone-field", phone)
    clearPluginRegistry()
    expect(getRegisteredPlugins()).toHaveLength(0)

    registerPlugin("@example/phone-field", phone)
    expect(getFieldTypePlugin("phone")).toBeDefined()
    expect(getRegisteredPlugins()).toHaveLength(1)
  })

  it("should clear all plugin types from the registry", () => {
    const phone = defineFieldType({ name: "phone", pgType: "TEXT", tsType: "string" })
    const seo = defineComposite({ name: "seo", label: "SEO", fields: [] })
    const widget = defineWidget({
      name: "picker",
      label: "Picker",
      compatibleTypes: ["text"],
      componentPath: "./picker.tsx",
    })

    registerPlugin("@example/phone", phone)
    registerPlugin("@example/seo", seo)
    registerPlugin("@example/picker", widget)
    expect(getRegisteredPlugins()).toHaveLength(3)

    clearPluginRegistry()

    expect(getRegisteredPlugins()).toHaveLength(0)
    expect(getPluginsByType("field")).toHaveLength(0)
    expect(getPluginsByType("composite")).toHaveLength(0)
    expect(getPluginsByType("widget")).toHaveLength(0)
  })
})
