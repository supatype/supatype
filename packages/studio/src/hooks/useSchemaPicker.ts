import { useEffect, useState } from "react"
import { pickDefaultSchema } from "../lib/schema-picker.js"
import { useApiQuery } from "./useApiQuery.js"
import { useProjectProxy } from "./useProjectProxy.js"

/** Schema dropdown state: only schemas that have base tables; default away from public. */
export function useSchemaPicker(): {
  schemas: string[]
  schema: string
  setSchema: (schema: string) => void
  schemasLoading: boolean
} {
  const proxy = useProjectProxy()
  const { data, loading } = useApiQuery(() => proxy.schemas(), [proxy])
  const schemas = data ?? []
  const [schema, setSchema] = useState(() => pickDefaultSchema(schemas))

  useEffect(() => {
    if (schemas.length === 0) return
    if (!schemas.includes(schema)) {
      setSchema(pickDefaultSchema(schemas))
    }
  }, [schemas, schema])

  return { schemas, schema, setSchema, schemasLoading: loading }
}
