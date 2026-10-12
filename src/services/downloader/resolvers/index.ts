import { assertPublicHttpUrl } from '../safe-fetch.js'
import { resolveUnshorten } from "./unshorten.js"
import { resolveSafelinku } from "./safelinku.js"
import { resolveSub2Unlock } from "./sub2unlock.js"
import { resolveRekonise } from "./rekonise.js"

export { resolveUnshorten } from "./unshorten.js"
export { resolveSafelinku } from "./safelinku.js"
export { resolveSub2Unlock } from "./sub2unlock.js"
export { resolveRekonise } from "./rekonise.js"


export async function resolveBypass(url: string): Promise<any> {
  const parsed = await assertPublicHttpUrl(url.trim())
  const cleanUrl = parsed.href
  if (/(^|\.)(?:sfl\.gl|safelinku\.com|idsly\.bid|idsly\.net|safelinkblogger\.com)$/.test(parsed.hostname)) {
    return resolveSafelinku(cleanUrl, true)
  }
  if (/(^|\.)(?:sub2unlock\.(?:com|io|net)|sub4unlock\.com)$/.test(parsed.hostname)) {
    return resolveSub2Unlock(cleanUrl, true)
  }
  if (/(^|\.)rekonise\.com$/.test(parsed.hostname)) {
    return resolveRekonise(cleanUrl, true)
  }
  return resolveUnshorten(cleanUrl, true)
}
