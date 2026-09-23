// ─── @supatype/studio ─────────────────────────────────────────────────────────
// Library entry point for consuming the studio as a package.
// The cloud studio (or any host app) imports from this barrel.

// Core component
export { StudioCore } from "./StudioCore.js"

// Types
export type {
  StudioCoreProps,
  StudioExtension,
  RouteExtension,
  SidebarSection,
  StudioMode,
  NavItem,
  AdminConfig,
  ModelConfig,
  GlobalConfig,
  FieldConfig,
  WidgetType,
  SupatypeClient,
} from "./types.js"

export type {
  BlockTypeConfig,
  NavGroup as ConfigNavGroup,
  NavItem as ConfigNavItem,
  LocaleConfigAdmin,
  BrandingConfig,
  LivePreviewConfig,
  DashboardConfig,
  DashboardBlock,
  DashboardView,
  DASHBOARD_VIEW_LIMITS,
  Tier,
} from "./config.js"

// Hooks
export { AdminConfigContext, useAdminConfig } from "./hooks/useAdminConfig.js"
export { AdminClientContext, useAdminClient } from "./hooks/useAdminClient.js"
export { LocaleContext, useLocale, useLocaleState } from "./hooks/useLocale.js"

// Components
export { Sidebar, getPageTitle } from "./components/Sidebar.js"
export { Icon } from "./components/icons.js"
export { TopBar } from "./components/TopBar.js"
export { StudioConfigError } from "./components/StudioConfigError.js"
export type { StudioConfigErrorKind, StudioConfigErrorProps } from "./components/StudioConfigError.js"
export { mockConfig } from "./fixtures/mockConfig.js"
export { Header } from "./components/Header.js"
export { LocaleSwitcher } from "./components/LocaleSwitcher.js"
export { LivePreviewPane } from "./components/LivePreviewPane.js"
export { SupatypeIcon, SupatypeWordmark } from "./components/SupatypeLogo.js"

// UI primitives
// The primitives Studio is actually built from.
//
// There used to be two of each: a shadcn copy under components/ui/ that this file exported, and the
// one every view imports. Nothing in Studio, the cloud app or this monorepo imported the exported
// pair, so the package advertised components nobody used while the ones it is made of were not
// exported at all. They had already drifted apart on `sm`, `ghost` and `secondary`, and `icon` came
// to mean a 40px square in one and a shrink-wrapped glyph in the other.
//
// Removing them drops CardHeader/CardTitle/CardDescription/CardContent, which have no equivalent
// here and no caller anywhere.
export { Badge, Button, Card, Input } from "./components/ui.js"

// Widgets
export { FieldWidget } from "./widgets/FieldWidget.js"
export { TextWidget } from "./widgets/TextWidget.js"
export { NumberWidget } from "./widgets/NumberWidget.js"
export { BooleanWidget } from "./widgets/BooleanWidget.js"
export { DateWidget } from "./widgets/DateWidget.js"
export { SelectWidget } from "./widgets/SelectWidget.js"
export { ImageWidget } from "./widgets/ImageWidget.js"
export { FileWidget } from "./widgets/FileWidget.js"
export { RelationWidget } from "./widgets/RelationWidget.js"
export { RichTextWidget } from "./widgets/RichTextWidget.js"
export { JsonWidget } from "./widgets/JsonWidget.js"
export { BlocksWidget } from "./widgets/BlocksWidget.js"
export { PublishWidget } from "./widgets/PublishWidget.js"

// Database components
export { ConnectionStringPanel } from "./components/database/ConnectionStringPanel.js"
export type { ConnectionStringPanelProps } from "./components/database/ConnectionStringPanel.js"
export { DatabasePasswordPanel } from "./components/database/DatabasePasswordPanel.js"
export type { DatabasePasswordPanelProps } from "./components/database/DatabasePasswordPanel.js"

// Monitoring components
export { SlowQueryLog } from "./components/monitoring/SlowQueryLog.js"
export type { SlowQueryLogProps } from "./components/monitoring/SlowQueryLog.js"

// Plugin system
export { registerWidget, getWidgetsForType, getWidget } from "./plugins/WidgetRegistry.js"
export type { WidgetEntry, WidgetRegistration } from "./plugins/WidgetRegistry.js"
export { WidgetLoader } from "./plugins/WidgetLoader.js"
export type { WidgetLoaderProps } from "./plugins/WidgetLoader.js"
export { WidgetErrorBoundary } from "./plugins/WidgetErrorBoundary.js"
export type { WidgetErrorBoundaryProps } from "./plugins/WidgetErrorBoundary.js"
export { CompositeFieldGroup } from "./plugins/CompositeFieldGroup.js"
export type { CompositeField, CompositeFieldGroupProps } from "./plugins/CompositeFieldGroup.js"

// Utilities
export { cn } from "./lib/utils.js"
export { normalizeAdminConfig } from "./lib/normalize-admin-config.js"
