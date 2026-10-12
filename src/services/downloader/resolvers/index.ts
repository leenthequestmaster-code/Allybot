import { resolveUnshorten } from "./unshorten.js"
import { resolveSafelinku } from "./safelinku.js"
import { resolveSub2Unlock } from "./sub2unlock.js"
import { resolveRekonise } from "./rekonise.js"

export { resolveUnshorten } from "./unshorten.js"
export { resolveSafelinku } from "./safelinku.js"
export { resolveSub2Unlock } from "./sub2unlock.js"
export { resolveRekonise } from "./rekonise.js"

const SAFELINKU_REGEX = /https?:\/\/(?:[a-zA-Z0-9-]+\.)?(?:sfl\.gl|safelinku\.com|idsly\.bid|idsly\.net|safelinkblogger\.com)\/[^\s]+/i
const SUB2UNLOCK_REGEX = /https?:\/\/(?:[a-zA-Z0-9-]+\.)?(?:sub2unlock\.(?:com|io|net)|sub4unlock\.com)\/[^\s]+/i
const REKONISE_REGEX = /https?:\/\/(?:[a-zA-Z0-9-]+\.)?rekonise\.com\/[^\s]+/i

export async function resolveBypass(url: string): Promise<any> {
  const cleanUrl = url.trim()
  if (SAFELINKU_REGEX.test(cleanUrl)) {
    return resolveSafelinku(cleanUrl, true)
  }
  if (SUB2UNLOCK_REGEX.test(cleanUrl)) {
    return resolveSub2Unlock(cleanUrl, true)
  }
  if (REKONISE_REGEX.test(cleanUrl)) {
    return resolveRekonise(cleanUrl, true)
  }
  return resolveUnshorten(cleanUrl, true)
}
