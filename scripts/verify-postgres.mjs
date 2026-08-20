import 'dotenv/config'
import { createPostgresVerifier, readPostgresVerificationConfig, redactPostgresError } from '../dist/postgres-verifier.js'

const config = readPostgresVerificationConfig()
if (!config) {
  console.error('POSTGRES_URL is required to run PostgreSQL verification')
  process.exitCode = 2
} else {
  const verifier = createPostgresVerifier(config)
  try {
    const result = await verifier.verify()
    console.log(`POSTGRES_VERIFY=PASS (${result.checked})`)
  } catch (error) {
    console.error(`POSTGRES_VERIFY=FAIL (${redactPostgresError(error)})`)
    process.exitCode = 1
  } finally {
    await verifier.close()
  }
}
