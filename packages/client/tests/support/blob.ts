/**
 * A file body for upload tests. The client never checks a file's size: the storage server
 * decides limits and quotas, and these suites mock its answer. So the tests upload small blobs,
 * because a real 500 MB one costs real memory and timed out on CI runners.
 *
 * Not named `*.test.ts`, so vitest's default include does not collect it as a suite.
 */
export function createMockBlob(sizeBytes: number): Blob {
  return new Blob([new Uint8Array(sizeBytes)])
}
