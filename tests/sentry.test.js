import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadConfig, publicConfig } from '../dist/config.js'
import { createSentryReporter } from '../dist/sentry.js'

test('Sentry telemetry is disabled and side-effect free by default', async () => {
  const config = loadConfig({ NODE_ENV: 'test' })
  const reporter = createSentryReporter(config, {})

  assert.equal(config.SENTRY_ENABLED, false)
  assert.equal(config.SENTRY_TRACES_SAMPLE_RATE, 0)
  assert.equal(reporter.isEnabled, false)
  reporter.captureError('test:error', new Error('must not be sent'))
  reporter.captureMessage('test:checkpoint', 'completed')
  await reporter.close()

  const exposed = publicConfig(config)
  assert.equal(exposed.sentryEnabled, false)
  assert.equal(exposed.sentryEnvironment, 'production')
  assert.equal(exposed.sentryReleaseConfigured, false)
  assert.equal(exposed.sentryTracesSampleRate, 0)
  assert.equal('sentryDsn' in exposed, false)
  assert.equal('SENTRY_DSN' in exposed, false)
})

test('Sentry telemetry requires an HTTPS DSN when enabled', () => {
  assert.throws(
    () => loadConfig({ SENTRY_ENABLED: 'true' }),
    /SENTRY_DSN is required when SENTRY_ENABLED=true/,
  )
  assert.throws(
    () => loadConfig({ SENTRY_DSN: 'http://example.test/project' }),
    /SENTRY_DSN must use https:\/\//,
  )
  assert.throws(
    () => loadConfig({ SENTRY_ENABLED: 'true', SENTRY_DSN: 'https://example.test/project', SENTRY_TRACES_SAMPLE_RATE: '1.1' }),
    /Invalid Allybot configuration/,
  )
})

test('Sentry labels and environment are bounded', () => {
  assert.throws(
    () => loadConfig({ SENTRY_ENVIRONMENT: 'acceptance environment' }),
    /Invalid Allybot configuration/,
  )
  assert.throws(
    () => loadConfig({ SENTRY_RELEASE: 'release with spaces' }),
    /Invalid Allybot configuration/,
  )
  const config = loadConfig({
    SENTRY_ENABLED: 'true',
    SENTRY_DSN: 'https://example.test/project',
    SENTRY_ENVIRONMENT: 'acceptance',
    SENTRY_RELEASE: 'abc123',
    SENTRY_TRACES_SAMPLE_RATE: '0.05',
  })
  assert.equal(config.SENTRY_ENVIRONMENT, 'acceptance')
  assert.equal(config.SENTRY_RELEASE, 'abc123')
  assert.equal(config.SENTRY_TRACES_SAMPLE_RATE, 0.05)
})


test('Sentry plugin observes only safe framework-level failure events', async () => {
  const listeners = new Map()
  const errors = []
  const messages = []
  const reporter = {
    isEnabled: true,
    captureError: (operation, error) => errors.push({ operation, error }),
    captureMessage: (operation, status) => messages.push({ operation, status }),
    close: async () => undefined,
  }
  const { createSentryPlugin } = await import('../dist/framework/plugins/sentry.js')
  const plugin = createSentryPlugin(reporter)

  plugin.initialize({
    events: {
      on: (name, listener) => {
        listeners.set(name, listener)
        return () => listeners.delete(name)
      },
    },
  })

  await listeners.get('framework.error')({ source: 'command:ping', error: { name: 'TimeoutError', message: 'sensitive' } })
  await listeners.get('plugin.failed')({ name: 'group-context', error: { name: 'ConfigError' } })
  await listeners.get('connection.changed')({ status: 'failed' })
  await listeners.get('connection.changed')({ status: 'connected' })

  assert.deepEqual(errors.map(({ operation }) => operation), ['command:ping', 'plugin:group-context'])
  assert.equal(errors[0].error.message, 'sensitive')
  assert.deepEqual(messages, [{ operation: 'connection:failed', status: 'failed' }])
})
