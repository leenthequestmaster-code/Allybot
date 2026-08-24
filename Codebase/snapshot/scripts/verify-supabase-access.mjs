import 'dotenv/config'
import {
  createPostgresVerifier,
  readPostgresVerificationConfig,
  redactPostgresError,
} from '../dist/postgres-verifier.js'
import {
  createSupabaseReadWriteClient,
  readSupabaseReadWriteConfig,
} from '../dist/supabase-read-write.js'

const readOnlyConfig = readPostgresVerificationConfig()
const readWriteConfig = readSupabaseReadWriteConfig()

if (!readOnlyConfig) {
  console.error('SUPABASE_ACCESS=FAIL (POSTGRES_URL is required for read-only verification)')
  process.exitCode = 2
} else if (!readWriteConfig) {
  console.error('SUPABASE_ACCESS=FAIL (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for read-write initialization)')
  process.exitCode = 2
} else {
  const verifier = createPostgresVerifier(readOnlyConfig)
  try {
    const readOnlyResult = await verifier.verify()
    createSupabaseReadWriteClient(readWriteConfig)
    console.log(`SUPABASE_ACCESS=PASS (readonly:${readOnlyResult.checked}, readwrite:client-initialized)`)
  } catch (error) {
    console.error(`SUPABASE_ACCESS=FAIL (${redactPostgresError(error)})`)
    process.exitCode = 1
  } finally {
    await verifier.close()
  }
}
