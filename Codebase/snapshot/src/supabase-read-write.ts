import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export interface SupabaseReadWriteConfig {
  url: string
  serviceRoleKey: string
}

const HTTPS_URL_PATTERN = /^https:\/\//i

export function readSupabaseReadWriteConfig(
  env: NodeJS.ProcessEnv = process.env,
): SupabaseReadWriteConfig | undefined {
  const url = env.SUPABASE_URL?.trim()
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!url && !serviceRoleKey) return undefined
  if (!url) throw new Error('SUPABASE_URL is required when SUPABASE_SERVICE_ROLE_KEY is set')
  if (!serviceRoleKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required when SUPABASE_URL is set')
  if (!HTTPS_URL_PATTERN.test(url)) throw new Error('SUPABASE_URL must use https://')

  return { url, serviceRoleKey }
}

export function createSupabaseReadWriteClient(
  config: SupabaseReadWriteConfig,
): SupabaseClient {
  return createClient(config.url, config.serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })
}
