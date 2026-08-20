import 'dotenv/config'
import { createNeonClient, readNeonClientConfig, redactNeonError } from '../dist/neon-client.js'

const config = readNeonClientConfig()
if (!config) {
  console.log('NEON_VERIFY=SKIP (NEON_ENABLED=false)')
} else {
  const sql = createNeonClient(config)
  try {
    const rows = await sql.unsafe('SELECT 1 AS ok LIMIT 1')
    if (rows.length !== 1 || rows[0]?.ok !== 1) throw new Error('Neon read-only verification returned an unexpected result')
    console.log('NEON_VERIFY=PASS (read-only-select-1)')
  } catch (error) {
    console.error(`NEON_VERIFY=FAIL (${redactNeonError(error)})`)
    process.exitCode = 1
  } finally {
    await sql.end({ timeout: 5 })
  }
}
