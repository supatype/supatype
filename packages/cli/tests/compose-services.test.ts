import { describe, expect, it } from "vitest"
import { logsArgs } from "../src/commands/logs.js"
import { composeArgs, parseComposePs } from "../src/compose-services.js"

/**
 * `supatype status` and `supatype logs` each carried a hardcoded list of container
 * names. Both lists were wrong: they named `supatype-postgres` and `supatype-kong`,
 * which the generated compose file does not create, and omitted `server`, `storage`,
 * `functions-worker`, `schema-engine` and `valkey`, which it does. The file sets no
 * `container_name`, so Docker names containers `<project>-<service>-<n>` and no
 * guessed name could ever have matched.
 *
 * The fix is to ask Compose. These tests cover the parsing and argument seams, which
 * are the parts that can be wrong without Docker present.
 */

const ctx = {
  composePath: "/proj/.supatype/self-host/docker-compose.yml",
  projectRoot: "/proj",
  projectName: "supatype-demo",
}

describe("parseComposePs", () => {
  // Compose v2 emits newline-delimited objects.
  it("reads the NDJSON form", () => {
    const stdout = [
      JSON.stringify({ Service: "server", Name: "supatype-demo-server-1", State: "running", Status: "Up 2 minutes" }),
      JSON.stringify({ Service: "db", Name: "supatype-demo-db-1", State: "exited", Status: "Exited (1)" }),
    ].join("\n")

    expect(parseComposePs(stdout)).toEqual([
      { service: "db", container: "supatype-demo-db-1", state: "exited", ports: "", status: "Exited (1)" },
      { service: "server", container: "supatype-demo-server-1", state: "running", ports: "", status: "Up 2 minutes" },
    ])
  })

  // Other versions emit one array. Which you get depends on the Docker installed.
  it("reads the array form", () => {
    const stdout = JSON.stringify([{ Service: "studio", Name: "supatype-demo-studio-1", State: "running" }])
    expect(parseComposePs(stdout).map((s) => s.service)).toEqual(["studio"])
  })

  it("sorts by service so the report is stable between runs", () => {
    const stdout = ["valkey", "db", "server"].map((s) => JSON.stringify({ Service: s, State: "running" })).join("\n")
    expect(parseComposePs(stdout).map((s) => s.service)).toEqual(["db", "server", "valkey"])
  })

  // Compose prefixes its own progress lines on some versions, and prints nothing
  // at all when the project has never been started.
  it("survives noise and emptiness", () => {
    expect(parseComposePs("")).toEqual([])
    expect(parseComposePs("   \n")).toEqual([])
    expect(parseComposePs("[not json")).toEqual([])
    expect(parseComposePs('pulling...\n{"Service":"db","State":"running"}')).toHaveLength(1)
  })

  // A row without a service name cannot be reported against, and a missing state
  // must not read as running.
  it("drops rows with no service and does not invent a state", () => {
    const stdout = [
      JSON.stringify({ Name: "orphan", State: "running" }),
      JSON.stringify({ Service: "db" }),
      "null",
    ].join("\n")
    const got = parseComposePs(stdout)
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ service: "db", state: "unknown", container: "", ports: "" })
  })

  describe("ports", () => {
    it("takes the string form as given", () => {
      const stdout = JSON.stringify({ Service: "db", State: "running", Publishers: "0.0.0.0:5432->5432/tcp" })
      expect(parseComposePs(stdout)[0]?.ports).toBe("0.0.0.0:5432->5432/tcp")
    })

    // Compose lists an entry per protocol and per host interface, so the same
    // mapping arrives several times over.
    it("renders the structured form, de-duplicated", () => {
      const stdout = JSON.stringify({
        Service: "db",
        State: "running",
        Publishers: [
          { URL: "0.0.0.0", TargetPort: 5432, PublishedPort: 5432, Protocol: "tcp" },
          { URL: "::", TargetPort: 5432, PublishedPort: 5432, Protocol: "tcp" },
          { URL: "0.0.0.0", TargetPort: 9000, PublishedPort: 19000, Protocol: "tcp" },
        ],
      })
      expect(parseComposePs(stdout)[0]?.ports).toBe("5432->5432, 19000->9000")
    })

    // An unpublished port is reachable only from inside the network, so reporting
    // it would tell the developer to try an address that will refuse.
    it("omits ports that are not published to the host", () => {
      const stdout = JSON.stringify({
        Service: "valkey",
        State: "running",
        Publishers: [{ URL: "", TargetPort: 6379, PublishedPort: 0, Protocol: "tcp" }, null, "nonsense"],
      })
      expect(parseComposePs(stdout)[0]?.ports).toBe("")
    })
  })
})

describe("composeArgs", () => {
  // Without --project-directory, Compose resolves relative build contexts and
  // env_file paths against .supatype/self-host/ rather than the project root.
  it("names the project, the project directory and the file", () => {
    expect(composeArgs(ctx)).toEqual([
      "compose",
      "-p",
      "supatype-demo",
      "--project-directory",
      "/proj",
      "-f",
      "/proj/.supatype/self-host/docker-compose.yml",
    ])
  })
})

describe("logsArgs", () => {
  it("tails the whole stack by default", () => {
    expect(logsArgs(["compose"], { since: "5m", follow: true })).toEqual([
      "compose",
      "logs",
      "--tail",
      "100",
      "--follow",
      "--since",
      "5m",
    ])
  })

  // The service name is the Compose service, and it has to come last: Compose
  // reads trailing arguments as the services to tail.
  it("puts the service last", () => {
    const args = logsArgs(["compose"], { service: "server", follow: false })
    expect(args.at(-1)).toBe("server")
    expect(args).not.toContain("--follow")
  })

  it("omits --since when there is none", () => {
    expect(logsArgs(["compose"], {})).not.toContain("--since")
  })
})
