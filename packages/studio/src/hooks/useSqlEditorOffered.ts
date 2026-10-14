import { sqlEditorOffered } from "../lib/sql-editor-access.js"
import { useStudioCapability } from "./useStudioCapability.js"

/**
 * Whether this caller is offered the SQL editor, and so every write Studio makes through its route
 * (RX1, RQ4): creating or dropping tables, views, functions, triggers, types and policies, enabling
 * extensions and switching RLS. Owners, admins and developers; the server refuses everyone else.
 */
export function useSqlEditorOffered(): boolean {
  return sqlEditorOffered(useStudioCapability())
}
