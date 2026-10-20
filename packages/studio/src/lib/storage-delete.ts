import type { BucketClient } from "@supatype/client"

/**
 * Deleting a selection in the Storage browser: the files it names, and every object under each
 * folder it names.
 *
 * Both storage servers delete objects by exact name (`{ prefixes }` is a list of object names, as
 * Supabase's is), and a folder is not an object: it is the shared start of its objects' names. So
 * the folder's own name matched nothing, the server answered an empty list, and Studio called that
 * done while the folder and its `.emptyFolderPlaceholder` stayed. A folder is now read down to its
 * objects first, and the answer is compared with what was asked, so objects the server keeps (its
 * delete rule refused them) are reported rather than passed over.
 */

/** The bucket calls a delete needs. */
export type StorageDeleteApi = Pick<BucketClient, "list" | "remove">

/** One selected row: its name in the folder on screen, and whether it is a folder. */
export interface StorageSelection {
  name: string
  isFolder: boolean
}

/** Entries asked for per list page while walking a folder. */
const WALK_PAGE = 1000
/** Names sent per delete request. */
const REMOVE_CHUNK = 1000

function joinPath(folder: string, name: string): string {
  return folder === "" ? name : `${folder}/${name}`
}

/** One list page of `folder`, or throws with the server's reason. */
async function listPage(api: StorageDeleteApi, folder: string, offset: number): Promise<Array<{ id: string | null; name: string }>> {
  const { data, error } = await api.list(folder, { limit: WALK_PAGE, offset })
  if (error) throw new Error(error.message)
  return data ?? []
}

/** Every object name anywhere under `folder`, read a page at a time. */
export async function objectsUnder(api: StorageDeleteApi, folder: string): Promise<string[]> {
  const names: string[] = []
  for (let offset = 0; ; offset += WALK_PAGE) {
    const page = await listPage(api, folder, offset)
    for (const entry of page) {
      const path = joinPath(folder, entry.name)
      if (entry.id === null) names.push(...(await objectsUnder(api, path)))
      else names.push(path)
    }
    if (page.length < WALK_PAGE) return names
  }
}

/** The object names a selection in `folder` stands for. */
async function namesOf(api: StorageDeleteApi, folder: string, selection: readonly StorageSelection[]): Promise<string[]> {
  const names: string[] = []
  for (const item of selection) {
    const path = joinPath(folder, item.name)
    if (item.isFolder) names.push(...(await objectsUnder(api, path)))
    else names.push(path)
  }
  return names
}

/** Deletes `names` a chunk at a time and answers how many the server removed. */
async function removeAll(api: StorageDeleteApi, names: readonly string[]): Promise<number> {
  let removed = 0
  for (let i = 0; i < names.length; i += REMOVE_CHUNK) {
    const { data, error } = await api.remove(names.slice(i, i + REMOVE_CHUNK))
    if (error) throw new Error(error.message)
    removed += data?.length ?? 0
  }
  return removed
}

/**
 * Deletes the selection in `folder` ("" for the bucket root). Null when everything asked for went,
 * otherwise what stayed, in words. Throws with the server's reason when a request is refused.
 */
export async function deleteSelection(api: StorageDeleteApi, folder: string, selection: readonly StorageSelection[]): Promise<string | null> {
  const names = await namesOf(api, folder, selection)
  const kept = names.length - (await removeAll(api, names))
  if (kept === 0) return null
  const noun = names.length === 1 ? "object" : "objects"
  return `${kept} of ${names.length} ${noun} could not be deleted. Your role may not be allowed to delete them.`
}
