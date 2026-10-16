/**
 * Reading an event stream from a fetch response, as the admin stream suites do.
 *
 * Node types a fetch body's chunks as `any`. A byte stream yields `Uint8Array`, so each chunk is
 * checked to be one before it is decoded.
 */

export interface TextDecoderLike {
  decode(input: Uint8Array, options?: { stream?: boolean }): string
}

export interface StreamReader {
  read(): Promise<{ done: boolean; value?: unknown }>
}

/** The next chunk as text, or null once the stream has ended. */
export async function nextText(reader: StreamReader, decoder: TextDecoderLike): Promise<string | null> {
  const chunk = await reader.read()
  if (chunk.done) return null
  if (!(chunk.value instanceof Uint8Array)) throw new Error("the stream yielded a chunk that is not bytes")
  return decoder.decode(chunk.value, { stream: true })
}
