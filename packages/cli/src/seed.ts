import pg from "pg"

export interface SeedSql {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<pg.QueryResult>
  end(): Promise<void>
}

/** Lightweight tagged-template SQL helper for project `seed.ts` scripts. */
export function sql(connectionString: string): SeedSql {
  const client = new pg.Client({ connectionString })
  let connected = false

  const ensureConnected = async (): Promise<void> => {
    if (!connected) {
      await client.connect()
      connected = true
    }
  }

  const tag = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<pg.QueryResult> => {
    await ensureConnected()
    let text = ""
    for (let i = 0; i < strings.length; i++) {
      text += strings[i]
      if (i < values.length) {
        text += `$${i + 1}`
      }
    }
    return client.query(text, values)
  }

  return Object.assign(tag, {
    end: async (): Promise<void> => {
      if (connected) {
        await client.end()
        connected = false
      }
    },
  })
}
