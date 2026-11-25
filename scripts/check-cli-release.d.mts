/** What `releaseProblems` is told about a release; see check-cli-release.mjs. */
export interface ReleaseFacts {
  version: string
  scaffolded: string[]
  publishing: string[]
  isPublished: (name: string, version: string) => Promise<boolean>
  embeddedPublicKey: string
  clientPrepareBin: string | undefined
  prepareCommand: string
  cdnHas: (path: string) => Promise<boolean>
}

export function releaseProblems(facts: ReleaseFacts): Promise<string[]>
export function scaffoldedPackages(initPackageJsonSource: string): string[]
export function publishedPackages(releaseWorkflow: string): string[]
export function embeddedKeyOf(releasePublicKeySource: string): string
