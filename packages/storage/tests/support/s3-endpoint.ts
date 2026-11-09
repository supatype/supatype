/**
 * An S3 endpoint for every test file, set before any module loads. The service refuses to start
 * without one (s3-settings.ts), and most suites never reach S3: they mock the store or use the file
 * backend. Nothing listens on port 1, so a test that does reach S3 by mistake fails at once. Suites
 * that test the settings themselves clear it first.
 */
process.env["S3_ENDPOINT"] ??= "http://127.0.0.1:1"
