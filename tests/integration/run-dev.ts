import { chdir } from 'node:process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '../../packages/cli/src/cli.js'

// Set CWD to this directory so the CLI finds the local supatype config here.
chdir(dirname(fileURLToPath(import.meta.url)))

run()
