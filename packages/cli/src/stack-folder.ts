/**
 * Refuse to work with a local stack another folder started.
 *
 * A stack's compose project is `supatype-` plus `project.name`, so a second folder of the same
 * project names the same stack: a copy made for the docs' compose deploy, or a second checkout.
 * From that folder, `self-host compose down` removed the first folder's running dev stack with exit
 * 0, `--volumes` would have deleted its database, and its `dev` recreated that database with the
 * second folder's password (0.9.2 release test round 5, RB-2). Compose records on every container
 * the files it was started from, so a stack whose files are another folder's is refused.
 *
 * With its containers gone, a stack's database volume stays, and nothing on Docker names its folder:
 * a label on the volume would, but compose asks to recreate (and empty) a volume whose labels
 * change, so every existing project would be asked once. Starting a stack records its folder in
 * `~/.supatype/stacks.json` instead, and a stack with volumes and no containers is the recorded
 * folder's while that folder exists.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { isArrayOf, isShape, isString, parseJsonObject } from "@supatype/shared"
import { askDockerSync, DOCKER_QUERY_TIMEOUT_MS } from "./docker-exec.js"
import { comparablePath } from "./dev-session-lock.js"
import { supatypeProjectsRoot } from "./project-config.js"
import { PROJECT_NAME_ENV } from "./project-name-override.js"
import { projectRootOfComposePath, selfHostComposePaths } from "./self-host-compose.js"
import { fatalError } from "./ui/fatal.js"

const CONFIG_FILES_LABEL = "com.docker.compose.project.config_files"

/** A compose file, as the label lists one; anything else in it says nothing about a folder. */
const COMPOSE_FILE = /\.ya?ml$/i

/**
 * Each compose project's answer, once per run: no other folder takes a stack over while one command
 * runs, and a push asks from several places, each a synchronous `docker ps`.
 */
const answers = new Map<string, string[][] | null>()

/**
 * The compose files each container of `composeProject` was started from, one list per container.
 * Null when docker cannot say, which is no reason to refuse: the command then fails on its own.
 */
function stackComposeFiles(composeProject: string): string[][] | null {
  const known = answers.get(composeProject)
  if (known !== undefined) return known
  const listed = askDockerSync(
    ["ps", "-a", "--filter", `label=com.docker.compose.project=${composeProject}`, "--format", `{{.Label "${CONFIG_FILES_LABEL}"}}`],
    { timeoutMs: DOCKER_QUERY_TIMEOUT_MS },
  )
  const files = listed.status !== 0
    ? null
    : listed.stdout
        .split(/\r?\n/)
        .map((line) => line.split(",").map((file) => file.trim()).filter((file) => COMPOSE_FILE.test(file)))
        .filter((list) => list.length > 0)
  answers.set(composeProject, files)
  return files
}

/**
 * The folder another stack under `composeProject` was started from, when one was; undefined when
 * every container of it is this folder's, or there are none and no other folder's volumes are left.
 */
export function otherFoldersStack(cwd: string, composeProject: string, files: string[][] | null = stackComposeFiles(composeProject)): string | undefined {
  if (files === null) return undefined
  if (files.length === 0) return recordedOtherFolder(cwd, composeProject)
  const own = comparablePath(selfHostComposePaths(cwd).composePath)
  const foreign = files.find((list) => !list.some((file) => comparablePath(file) === own))
  return foreign?.[0] === undefined ? undefined : projectRootOfComposePath(foreign[0])
}

interface StackRecord {
  composeProject: string
  projectDir: string
}

const isStacksFile = isShape({ stacks: isArrayOf(isShape({ composeProject: isString, projectDir: isString })) })

/** `~/.supatype/stacks.json`. Read at each call, so a test's own home is used. */
function recordsPath(): string {
  return join(dirname(supatypeProjectsRoot()), "stacks.json")
}

/** The records whose folder still exists: a deleted project owns nothing. */
function liveRecords(): StackRecord[] {
  try {
    const path = recordsPath()
    if (!existsSync(path)) return []
    const parsed = parseJsonObject(readFileSync(path, "utf8"))
    if (!parsed.ok || !isStacksFile(parsed.value)) return []
    return parsed.value.stacks.filter((record) => existsSync(record.projectDir))
  } catch {
    // An unreadable file names no owner: the container check alone stands, as before.
    return []
  }
}

/** Record that `cwd` started the stack `composeProject`. Best effort: a failure only loses the record. */
export function recordStackFolder(cwd: string, composeProject: string): void {
  try {
    const stacks = [...liveRecords().filter((record) => record.composeProject !== composeProject), { composeProject, projectDir: cwd }]
    mkdirSync(dirname(recordsPath()), { recursive: true })
    writeFileSync(recordsPath(), `${JSON.stringify({ stacks }, null, 2)}\n`, "utf8")
  } catch {
    // The home folder is not writable: a stack with no containers is then not guarded.
  }
}

/** The recorded folder of a stack with no containers, when it is another and its volumes remain. */
function recordedOtherFolder(cwd: string, composeProject: string): string | undefined {
  const owner = liveRecords().find((record) => record.composeProject === composeProject)?.projectDir
  if (owner === undefined || comparablePath(owner) === comparablePath(cwd)) return undefined
  return stackHasVolumes(composeProject) ? owner : undefined
}

/** Whether compose volumes of `composeProject` are left: with none, there is nothing to protect. */
function stackHasVolumes(composeProject: string): boolean {
  const listed = askDockerSync(
    ["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${composeProject}`],
    { timeoutMs: DOCKER_QUERY_TIMEOUT_MS },
  )
  return listed.status === 0 && listed.stdout.trim() !== ""
}

/** Exit 1 when the stack named `composeProject` is another folder's (module comment). */
export function refuseOtherFoldersStack(cwd: string, composeProject: string): void {
  const folder = otherFoldersStack(cwd, composeProject)
  if (folder === undefined) return
  fatalError(`The stack ${composeProject} belongs to another folder: ${folder}.`, [
    "Both folders name the same project, so they name the same stack. Running here would stop, recreate or delete that folder's containers and database.",
    `Give this folder a stack of its own: set ${PROJECT_NAME_ENV}=<name> in this shell, or pass --project-name <name>.`,
  ])
}

/** Forget every stack's answer, for a test that starts stacks between calls. */
export function forgetStackFolders(): void {
  answers.clear()
}
