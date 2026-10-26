import { contentWriteOffered } from "../lib/capability-offers.js"
import { useStudioCapability } from "./useStudioCapability.js"

/**
 * Whether this caller is offered changes to content (rows and files): every role but the viewer,
 * who reads. Before the server answers the controls stay, and the server still refuses.
 */
export function useContentWriteOffered(): boolean {
  return contentWriteOffered(useStudioCapability())
}
