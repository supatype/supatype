import { describe, expect, it } from "vitest"
import { dockerPgRunArgs } from "../src/docker-postgres.js"

describe("dockerPgRunArgs", () => {
  const args = dockerPgRunArgs({
    name: "supatype-acme",
    volume: "supatype-acme-data",
    port: 54322,
    image: "supatype/postgres:17.2.14",
    envArgs: ["-e", "POSTGRES_PASSWORD"],
  })

  it("starts the container with an init, so postgres is not PID 1", () => {
    expect(args.slice(0, 3)).toEqual(["run", "-d", "--init"])
  })

  it("keeps the image last and the env, port and volume in place", () => {
    expect(args).toEqual([
      "run", "-d", "--init", "--name", "supatype-acme", "-e", "POSTGRES_PASSWORD",
      "-p", "54322:5432", "-v", "supatype-acme-data:/var/lib/postgresql/data", "supatype/postgres:17.2.14",
    ])
  })
})
