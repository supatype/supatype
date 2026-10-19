/**
 * A list entry exactly as the storage service sends one: the entry in
 * packages/storage/tests/fixtures/list-entry.json, the contract every storage server is checked
 * against. storage-object-shape.test.ts keeps the two equal. The suites that need a list answer
 * build from this, so a change to the shape is made in one place.
 *
 * Not named `*.test.ts`, so vitest's default include does not collect it as a suite.
 */
export const LISTED = {
  id: "c385ffde-42b3-45e5-8981-863515e0dbf6",
  bucket_id: "avatars",
  name: "shape-f9619cfd-f645-4f8d-bb42-3ed73bb0a36d.txt",
  owner: "7ea80d5c-e81e-48e7-8f27-2c2218ac42ac",
  metadata: { size: 4, mimetype: "text/plain" },
  created_at: "2026-10-18T07:52:09.909Z",
  updated_at: "2026-10-18T07:52:09.909Z",
  last_accessed_at: "2026-10-18T07:52:09.909Z",
  size: 4,
  mimetype: "text/plain",
}

/** A subfolder as a list answers it: the `folder` entry of the same contract file. */
export const FOLDER = {
  id: null,
  bucket_id: "avatars",
  name: "photos",
  owner: null,
  metadata: null,
  created_at: null,
  updated_at: null,
  last_accessed_at: null,
  size: null,
  mimetype: null,
}

/** The same entry with every nullable field null, as for an object stored with no owner or metadata. */
export const UNOWNED = { ...LISTED, owner: null, metadata: null, size: null, mimetype: null }
