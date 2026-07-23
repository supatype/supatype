import type { AuthStorage } from "@supatype/client"

/** Minimal SecureStore surface (expo-secure-store). */
export interface SecureStoreLike {
  getItemAsync(key: string): Promise<string | null>
  setItemAsync(key: string, value: string): Promise<void>
  deleteItemAsync(key: string): Promise<void>
}

/** Minimal AsyncStorage surface. */
export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

/** Wrap expo-secure-store as an AuthStorage adapter. */
export function secureStoreAdapter(secureStore: SecureStoreLike): AuthStorage {
  return {
    getItem: (key) => secureStore.getItemAsync(key),
    setItem: (key, value) => secureStore.setItemAsync(key, value),
    removeItem: (key) => secureStore.deleteItemAsync(key),
  }
}

/** Wrap @react-native-async-storage/async-storage as an AuthStorage adapter. */
export function asyncStorageAdapter(asyncStorage: AsyncStorageLike): AuthStorage {
  return {
    getItem: (key) => asyncStorage.getItem(key),
    setItem: (key, value) => asyncStorage.setItem(key, value),
    removeItem: (key) => asyncStorage.removeItem(key),
  }
}
