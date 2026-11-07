import { describe, expect, it } from "vitest"
import { execFileClosingStdin, runCaptured } from "../src/run-captured.js"

/**
 * Issue 47: `supatype pull` hung forever. The engine binary reads its input from stdin when no
 * `--input` file is given, and `introspect` is given none, so the 0.9.0 engine waited on a stdin
 * pipe the CLI left open and never wrote to. A program run for its output gets a closed stdin: it
 * reads end-of-file at once, as `</dev/null` gave it in the report.
 */

/** A program that reads stdin to its end, then says so: what `introspect` does before it connects. */
const READS_STDIN = "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('eof'))"

/** `run`, or "hung" if it has not settled within `ms`. */
async function within<T>(run: Promise<T>, ms: number): Promise<T | "hung"> {
  let timer: NodeJS.Timeout | undefined
  const hung = new Promise<"hung">((resolve) => {
    timer = setTimeout(() => resolve("hung"), ms)
  })
  return Promise.race([run, hung]).finally(() => clearTimeout(timer))
}

describe("a program run for its output", () => {
  it("runCaptured (the host engine) gives it a closed stdin, so a read ends", async () => {
    const result = await within(runCaptured(process.execPath, ["-e", READS_STDIN]), 5_000)
    expect(result).not.toBe("hung")
    expect(result === "hung" ? "" : result.stdout).toBe("eof")
  }, 10_000)

  it("a docker call (the compose engine) gets its input, then end-of-file", async () => {
    const echoes = "let s='';process.stdin.on('data',(d)=>{s+=d});process.stdin.on('end',()=>process.stdout.write(s+'|eof'))"
    const run = new Promise<string>((resolve) => {
      execFileClosingStdin(process.execPath, ["-e", echoes], { encoding: "utf8" }, "sql", (_err, stdout) => resolve(stdout))
    })
    expect(await within(run, 5_000)).toBe("sql|eof")
  }, 10_000)
})
