# Shared Code

Files in `_shared/` are available to all functions via relative imports.
This directory is not deployed as a function.

Example: `import { sendEmail } from '../_shared/email.ts'`
