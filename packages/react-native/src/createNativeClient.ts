import {
  createClient,
  type AnyDatabase,
  type AugmentedDatabase,
  type AuthStorage,
  type SupatypeClient,
  type SupatypeClientConfig,
} from "@supatype/client"
import {
  asyncStorageAdapter,
  type AsyncStorageLike,
  secureStoreAdapter,
  type SecureStoreLike,
} from "./storage.js"

export type NativeStorageBackend = "secure-store" | "async-storage"

export interface CreateNativeClientConfig extends SupatypeClientConfig {
  /**
   * Preferred persistence backend when `auth.storage` is not set.
   * Default: `"secure-store"` when `secureStore` is provided, else `"async-storage"`.
   */
  storageBackend?: NativeStorageBackend | undefined
  /** Pass `import * as SecureStore from "expo-secure-store"`. Preferred for mobile. */
  secureStore?: SecureStoreLike | undefined
  /** Pass `AsyncStorage` from `@react-native-async-storage/async-storage`. */
  asyncStorage?: AsyncStorageLike | undefined
}

function resolveNativeStorage(config: CreateNativeClientConfig): AuthStorage {
  if (config.auth?.storage !== undefined) {
    return config.auth.storage
  }

  const backend =
    config.storageBackend ??
    (config.secureStore !== undefined
      ? "secure-store"
      : config.asyncStorage !== undefined
        ? "async-storage"
        : null)

  if (backend === "secure-store") {
    if (config.secureStore === undefined) {
      throw new Error(
        '@supatype/react-native: storageBackend "secure-store" requires the `secureStore` option (import * as SecureStore from "expo-secure-store").',
      )
    }
    return secureStoreAdapter(config.secureStore)
  }

  if (backend === "async-storage") {
    if (config.asyncStorage === undefined) {
      throw new Error(
        '@supatype/react-native: storageBackend "async-storage" requires the `asyncStorage` option.',
      )
    }
    return asyncStorageAdapter(config.asyncStorage)
  }

  throw new Error(
    "@supatype/react-native: pass `secureStore` (recommended), `asyncStorage`, or `auth.storage` so sessions persist across app restarts.",
  )
}

/**
 * Create a Supatype client wired for React Native session persistence.
 *
 * @example
 * ```ts
 * import * as SecureStore from "expo-secure-store"
 * import { createNativeClient } from "@supatype/react-native"
 *
 * const client = createNativeClient({
 *   url: process.env.EXPO_PUBLIC_SUPATYPE_URL!,
 *   anonKey: process.env.EXPO_PUBLIC_SUPATYPE_ANON_KEY!,
 *   secureStore: SecureStore,
 * })
 * ```
 */
export function createNativeClient<TDatabase extends AnyDatabase = AugmentedDatabase>(
  config: CreateNativeClientConfig,
): SupatypeClient<TDatabase> {
  const storage = resolveNativeStorage(config)
  const { secureStore: _s, asyncStorage: _a, storageBackend: _b, auth, ...rest } = config

  return createClient<TDatabase>({
    ...rest,
    auth: {
      persistSession: auth?.persistSession ?? true,
      ...(auth?.storageKey !== undefined && { storageKey: auth.storageKey }),
      ...(auth?.cookiePrefix !== undefined && { cookiePrefix: auth.cookiePrefix }),
      storage,
    },
  })
}
