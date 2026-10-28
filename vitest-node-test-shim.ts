import * as vitest from 'vitest'

export function test(name: any, optionsOrFn?: any, maybeFn?: any) {
  const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn
  const opts = typeof optionsOrFn === 'object' ? optionsOrFn : {}

  if (!fn) {
    return (vitest.test as any)(name, opts)
  }

  return (vitest.test as any)(name, opts, async (ctx: any) => {
    if (ctx && typeof ctx.after !== 'function') {
      ctx.after = (cleanupFn: () => any) => {
        if (typeof ctx.onTestFinished === 'function') {
          ctx.onTestFinished(async () => {
            await cleanupFn()
          })
        }
      }
    }
    return fn(ctx)
  })
}

Object.assign(test, vitest.test)

export default test
export * from 'vitest'
