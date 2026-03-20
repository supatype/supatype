// @supatype/plugin-sdk — Plugin development kit for Supatype extensions

// Core types
export {
  PLUGIN_API_VERSION,
  type PluginType,
  type PluginMeta,
  type FieldTypeDefinition,
  type CompositeDefinition,
  type CompositeFieldDef,
  type ProviderDefinition,
  type ProviderCategory,
  type WidgetDefinition,
  type WidgetProps,
  type CommerceProvider,
  type TrackingProvider,
  type EmailProvider,
  type StorageProvider,
  type AuthProvider,
  type SSLProvider,
} from "./types.js"

// Builder functions
export {
  defineFieldType,
  defineComposite,
  defineProvider,
  defineWidget,
  isPluginDefinition,
  checkPluginApiVersion,
  type AnyPluginDefinition,
} from "./define.js"

// Documentation generator
export { generatePluginDocs } from "./docgen.js"

// Plugin loading and registry
export {
  registerPlugin,
  getRegisteredPlugins,
  getPluginsByType,
  getFieldTypePlugin,
  getProviderPlugin,
  clearPluginRegistry,
  isSupatypePlugin,
  sortByLoadOrder,
  detectConflicts,
  validateProviders,
  getPluginFieldTypeMap,
  getPluginFieldPgTypeMap,
  expandPluginComposites,
  type RegisteredPlugin,
  type PluginPackageInfo,
  type PluginConflict,
  type ProviderValidationResult,
  type FieldPgTypeInfo,
  type CompositeExpansion,
} from "./loader.js"
