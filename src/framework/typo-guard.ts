/**
 * Production-Grade Zero-Allocation "TypoGuard" Fuzzy String Matching & Typo Correction Engine
 * Target: Node.js 22 LTS (ESM, Strict TypeScript)
 *
 * Architectural Highlights:
 * 1. Bounded Optimal String Alignment (OSA / Restricted Damerau-Levenshtein) supporting:
 *    Insertion (+1), Deletion (+1), Substitution (+1), and Adjacent Transposition (+1).
 * 2. Dual-Path Execution:
 *    - Fast Path (Length <= 32): Hyyrö (2003) / Myers (1999) 32-bit unsigned bit-parallel
 *      Damerau-Levenshtein kernel with O(1) per-column early cutoff and selective mask cleanup.
 *    - Standard Path (Arbitrary Length): Ukkonen k-bounded 3-row rolling Dynamic Programming
 *      over a single flat pre-allocated Int32Array buffer with row-minimum early termination.
 * 3. Zero Heap Allocation in Hot Loops:
 *    - Pre-allocated reentrant ScratchSlot pool (Int32Array / Uint32Array / Float64Array).
 *    - In-place prefix stripping, ASCII case folding, and grapheme/code-point decoding.
 *    - Fixed-capacity top-K selection registers inside each ScratchSlot so scanning ratusan
 *      command candidates allocates zero intermediate objects.
 * 4. WhatsApp & Unicode Quirks:
 *    - Prefix-agnostic matching (strips '!', '/', '.', '#' without substring allocation).
 *    - Instant charCodeAt() fast path for pure ASCII (< 128).
 *    - Surrogate-pair, ZWJ emoji sequence (e.g. 👨‍👩‍👧), Variation Selector, and NFC-safe
 *      grapheme cluster folding when non-ASCII (> 127) is detected.
 */

export interface TypoGuardOptions {
  /** Maximum length of supported strings for pre-allocated buffers (default: 64) */
  maxWordLength?: number
  /** Command prefixes to automatically strip before comparison (default: ['!', '/', '.', '#']) */
  prefixes?: string[]
  /** Case-sensitive matching (default: false) */
  caseSensitive?: boolean
  /** Number of pre-allocated reentrant scratch slots for concurrent safety (default: 4) */
  poolSize?: number
}

export interface SuggestOptions {
  /** Maximum allowed edit distance (default: 2) */
  maxDistance?: number
  /** Minimum similarity ratio between 0.0 and 1.0 (default: 0.6) */
  minSimilarity?: number
  /** Limit number of returned suggestions (default: 1) */
  limit?: number
}

export interface Suggestion {
  candidate: string
  distance: number
  similarity: number // Formula: 1 - (distance / max(lenInput, lenCandidate))
}

const DEFAULT_PREFIXES: readonly string[] = ['!', '/', '.', '#']
const DEFAULT_MAX_WORD_LENGTH = 64
const DEFAULT_MAX_DISTANCE = 2
const DEFAULT_MIN_SIMILARITY = 0.6
const DEFAULT_LIMIT = 1
const DEFAULT_POOL_SIZE = 4
const EMPTY_SUGGESTIONS: Suggestion[] = []

/**
 * Internal pre-allocated scratchpad slot to guarantee zero GC pressure
 * and full reentrancy across concurrent/recursive executions.
 */
class ScratchSlot {
  inUse = false
  capacity: number
  stride: number
  bufA: Int32Array
  bufB: Int32Array
  /** Single flat buffer holding 3 rolling DP rows: [prev2Row | prev1Row | currRow] */
  dpFlat: Int32Array
  /** Direct O(1) pattern bitmask table for ASCII/Latin-1 code points (0..255) */
  peqAscii: Uint32Array
  /** Pre-allocated top-K suggestion registers to avoid object allocation during candidate scan */
  topIndices: Int32Array
  topDistances: Int32Array
  topSimilarities: Float64Array

  constructor(maxWordLength: number) {
    this.capacity = Math.max(32, maxWordLength)
    this.stride = this.capacity + 3
    this.bufA = new Int32Array(this.capacity)
    this.bufB = new Int32Array(this.capacity)
    this.dpFlat = new Int32Array(this.stride * 3)
    this.peqAscii = new Uint32Array(256)
    this.topIndices = new Int32Array(this.capacity)
    this.topDistances = new Int32Array(this.capacity)
    this.topSimilarities = new Float64Array(this.capacity)
  }

  ensureCapacity(requiredLength: number): void {
    if (requiredLength <= this.capacity) return
    let nextCap = this.capacity
    while (nextCap < requiredLength) nextCap <<= 1
    this.capacity = nextCap
    this.stride = nextCap + 3
    this.bufA = new Int32Array(nextCap)
    this.bufB = new Int32Array(nextCap)
    this.dpFlat = new Int32Array(this.stride * 3)
    if (this.topIndices.length < nextCap) {
      this.topIndices = new Int32Array(nextCap)
      this.topDistances = new Int32Array(nextCap)
      this.topSimilarities = new Float64Array(nextCap)
    }
  }

  ensureTopCapacity(limit: number): void {
    if (limit <= this.topIndices.length) return
    let nextCap = this.topIndices.length
    while (nextCap < limit) nextCap <<= 1
    this.topIndices = new Int32Array(nextCap)
    this.topDistances = new Int32Array(nextCap)
    this.topSimilarities = new Float64Array(nextCap)
  }
}

export class TypoGuard {
  private readonly maxWordLength: number
  private readonly prefixes: readonly string[]
  private readonly caseSensitive: boolean
  private readonly pool: ScratchSlot[]

  constructor(options?: TypoGuardOptions) {
    this.maxWordLength = Math.max(16, options?.maxWordLength ?? DEFAULT_MAX_WORD_LENGTH)
    // Sort prefixes longest-first so multi-char prefixes (e.g. '!!') match before '!'
    this.prefixes = options?.prefixes
      ? [...options.prefixes].filter((p) => p.length > 0).sort((a, b) => b.length - a.length)
      : DEFAULT_PREFIXES
    this.caseSensitive = options?.caseSensitive ?? false

    const poolCount = Math.max(1, options?.poolSize ?? DEFAULT_POOL_SIZE)
    this.pool = new Array<ScratchSlot>(poolCount)
    for (let i = 0; i < poolCount; i++) {
      this.pool[i] = new ScratchSlot(this.maxWordLength)
    }
  }

  /**
   * Acquires an isolated ScratchSlot from the pool (or allocates an overflow slot if all are busy).
   */
  private acquireSlot(): ScratchSlot {
    const pool = this.pool
    for (let i = 0; i < pool.length; i++) {
      const slot = pool[i]
      if (!slot.inUse) {
        slot.inUse = true
        return slot
      }
    }
    const overflow = new ScratchSlot(this.maxWordLength)
    overflow.inUse = true
    pool.push(overflow)
    return overflow
  }

  /**
   * Computes the starting UTF-16 index after stripping any configured leading command prefix
   * and leading/trailing ASCII whitespace, without allocating any substring.
   */
  private resolveBounds(raw: string): { start: number; end: number; hasNonAscii: boolean } {
    let start = 0
    let end = raw.length

    // Strip leading ASCII whitespace
    while (start < end && raw.charCodeAt(start) <= 32) start++
    // Strip trailing ASCII whitespace
    while (end > start && raw.charCodeAt(end - 1) <= 32) end--

    // Strip matching command prefix at `start`
    const prefixes = this.prefixes
    const pLen = prefixes.length
    for (let p = 0; p < pLen; p++) {
      const pref = prefixes[p]
      const L = pref.length
      if (end - start >= L) {
        let matched = true
        for (let k = 0; k < L; k++) {
          if (raw.charCodeAt(start + k) !== pref.charCodeAt(k)) {
            matched = false
            break
          }
        }
        if (matched) {
          start += L
          break
        }
      }
    }

    // Strip any whitespace immediately following the prefix (e.g. "! status")
    while (start < end && raw.charCodeAt(start) <= 32) start++

    // Fast scan for non-ASCII characters (> 127)
    let hasNonAscii = false
    for (let i = start; i < end; i++) {
      if (raw.charCodeAt(i) > 127) {
        hasNonAscii = true
        break
      }
    }

    return { start, end, hasNonAscii }
  }

  /**
   * Decodes a string into a pre-allocated Int32Array buffer of logical grapheme / code-point units.
   * - Pure ASCII path: zero-allocation loop using charCodeAt() and bitwise lowercase folding.
   * - Unicode path: NFC normalization + surrogate-pair codePointAt() + ZWJ / Variation-Selector
   *   grapheme cluster folding so emojis (🎲, 👨‍👩‍👧) never split or corrupt array indices.
   */
  private decodeIntoBuffer(
    raw: string,
    targetSlot: ScratchSlot,
    isBufferA: boolean,
  ): number {
    let start = 0
    let end = raw.length

    while (start < end && raw.charCodeAt(start) <= 32) start++
    while (end > start && raw.charCodeAt(end - 1) <= 32) end--

    const prefixes = this.prefixes
    for (let p = 0; p < prefixes.length; p++) {
      const pref = prefixes[p]
      const L = pref.length
      if (end - start >= L) {
        let matched = true
        for (let k = 0; k < L; k++) {
          if (raw.charCodeAt(start + k) !== pref.charCodeAt(k)) {
            matched = false
            break
          }
        }
        if (matched) {
          start += L
          break
        }
      }
    }
    while (start < end && raw.charCodeAt(start) <= 32) start++

    const sliceLen = end - start
    if (sliceLen <= 0) return 0

    targetSlot.ensureCapacity(sliceLen)
    const out = isBufferA ? targetSlot.bufA : targetSlot.bufB
    const caseSensitive = this.caseSensitive

    // Attempt pure ASCII fast path first (0 allocations)
    let writeIdx = 0
    for (let i = start; i < end; i++) {
      let c = raw.charCodeAt(i)
      if (c > 127) {
        // Non-ASCII detected: fallback to NFC + Grapheme/CodePoint-safe decoding
        return this.decodeUnicodeFallback(raw, start, end, targetSlot, isBufferA)
      }
      if (!caseSensitive && c >= 65 && c <= 90) {
        c |= 32 // Fast ASCII 'A'-'Z' -> 'a'-'z'
      }
      out[writeIdx++] = c
    }

    return writeIdx
  }

  /**
   * Unicode-safe NFC & Grapheme Cluster decoder for strings containing diacritics,
   * surrogate pairs, or ZWJ sequences (e.g. '🎲', '👨‍👩‍👧', 'é').
   */
  private decodeUnicodeFallback(
    raw: string,
    start: number,
    end: number,
    targetSlot: ScratchSlot,
    isBufferA: boolean,
  ): number {
    const sub = start === 0 && end === raw.length ? raw : raw.slice(start, end)
    const norm = (this.caseSensitive ? sub : sub.toLowerCase()).normalize('NFC')
    const nLen = norm.length
    targetSlot.ensureCapacity(nLen)
    const out = isBufferA ? targetSlot.bufA : targetSlot.bufB

    let writeIdx = 0
    let i = 0
    while (i < nLen) {
      let cp = norm.codePointAt(i)!
      i += cp > 0xffff ? 2 : 1

      // Fold Zero-Width Joiner (U+200D), Variation Selectors (U+FE0E..U+FE0F),
      // Combining Diacritical Marks (U+0300..U+036F), and Emoji Skin-Tone Modifiers (U+1F3FB..U+1F3FF)
      // into a single deterministic grapheme integer so complex emojis act as 1 logical character.
      while (i < nLen) {
        const nextCp = norm.codePointAt(i)!
        if (nextCp === 0x200d) {
          // ZWJ: consume joiner + the joined code point into the current grapheme cluster
          i += 1
          if (i < nLen) {
            const joinedCp = norm.codePointAt(i)!
            i += joinedCp > 0xffff ? 2 : 1
            cp = (((cp * 16777619) ^ joinedCp) & 0x7fffffff) | 0x200000
          }
        } else if (
          (nextCp >= 0xfe00 && nextCp <= 0xfe0f) ||
          (nextCp >= 0x1f3fb && nextCp <= 0x1f3ff) ||
          (nextCp >= 0x0300 && nextCp <= 0x036f)
        ) {
          i += nextCp > 0xffff ? 2 : 1
          if (nextCp !== 0xfe0f && nextCp !== 0xfe0e) {
            cp = (((cp * 16777619) ^ nextCp) & 0x7fffffff) | 0x200000
          }
        } else {
          break
        }
      }

      out[writeIdx++] = cp
    }

    return writeIdx
  }

  /**
   * Calculates bounded Damerau-Levenshtein (OSA) distance between two strings.
   * Returns distance, or (maxDistance + 1) if distance exceeds threshold.
   */
  distance(a: string, b: string, maxDistance?: number): number {
    const slot = this.acquireSlot()
    try {
      const lenA = this.decodeIntoBuffer(a, slot, true)
      const lenB = this.decodeIntoBuffer(b, slot, false)
      const maxD =
        maxDistance !== undefined
          ? Math.floor(maxDistance)
          : Math.max(lenA, lenB, this.maxWordLength)

      if (maxD < 0) return 0
      const diff = lenA >= lenB ? lenA - lenB : lenB - lenA
      if (diff > maxD) return maxD + 1

      return this.computeBufferedDistance(slot, lenA, lenB, maxD)
    } finally {
      slot.inUse = false
    }
  }

  /**
   * Core Dual-Path Kernel on pre-decoded Int32Array buffers (slot.bufA[0..lenA-1], slot.bufB[0..lenB-1]):
   * 1. O(1) common prefix & suffix trimming.
   * 2. Fast Path (interior length <= 32): Hyyrö (2003) 32-bit Bit-Parallel OSA kernel.
   * 3. Standard Path (interior length > 32): Ukkonen k-bounded 3-row flat Int32Array DP.
   */
  private computeBufferedDistance(
    slot: ScratchSlot,
    lenA: number,
    lenB: number,
    maxD: number,
  ): number {
    const bufA = slot.bufA
    const bufB = slot.bufB

    // 1. Trim identical leading code points
    let start = 0
    const minLen = lenA < lenB ? lenA : lenB
    while (start < minLen && bufA[start] === bufB[start]) {
      start++
    }

    // 2. Trim identical trailing code points
    let endA = lenA
    let endB = lenB
    while (endA > start && endB > start && bufA[endA - 1] === bufB[endB - 1]) {
      endA--
      endB--
    }

    const m = endA - start
    const n = endB - start

    if (m === 0) return n <= maxD ? n : maxD + 1
    if (n === 0) return m <= maxD ? m : maxD + 1

    // Ensure shorter interior sequence is pattern A so bit-parallel path applies whenever min(m, n) <= 32
    if (m <= 32 && n <= 32) {
      if (m <= n) {
        return this.bitParallelHyyro32(slot, bufA, start, m, bufB, start, n, maxD)
      } else {
        return this.bitParallelHyyro32(slot, bufB, start, n, bufA, start, m, maxD)
      }
    }

    return this.boundedRowDp(slot, bufA, start, m, bufB, start, n, maxD)
  }

  /**
   * Fast Path: Hyyrö (2003) 32-bit Bit-Parallel Damerau-Levenshtein (OSA) Kernel.
   * Zero heap allocations; uses pre-allocated `slot.peqAscii` for O(1) ASCII masks
   * and inline scan fallback for non-ASCII code points.
   */
  private bitParallelHyyro32(
    slot: ScratchSlot,
    pat: Int32Array,
    patStart: number,
    m: number,
    txt: Int32Array,
    txtStart: number,
    n: number,
    maxD: number,
  ): number {
    const peq = slot.peqAscii
    let hasHighCodePoint = false

    for (let i = 0; i < m; i++) {
      const cp = pat[patStart + i]
      if (cp < 256) {
        peq[cp] = (peq[cp] | (1 << i)) >>> 0
      } else {
        hasHighCodePoint = true
      }
    }

    let vp = m === 32 ? 0xffffffff : (((1 << m) - 1) >>> 0)
    let vn = 0
    let d0 = 0
    let pmOld = 0
    let score = m
    const highBit = (1 << (m - 1)) >>> 0
    const INF = maxD + 1

    for (let j = 0; j < n; j++) {
      const ch = txt[txtStart + j]
      let pm = 0
      if (ch < 256) {
        pm = peq[ch]
      } else if (hasHighCodePoint) {
        for (let i = 0; i < m; i++) {
          if (pat[patStart + i] === ch) pm = (pm | (1 << i)) >>> 0
        }
      }

      const tr = ((((~d0) & pm) << 1) & pmOld) >>> 0
      d0 = (tr | (((pm & vp) + vp) ^ vp) | pm | vn) >>> 0
      const hp = (vn | ~(d0 | vp)) >>> 0
      const hn = (vp & d0) >>> 0

      if ((hp & highBit) !== 0) score++
      else if ((hn & highBit) !== 0) score--

      // k-bounded early termination: even if every remaining column reduces score by 1,
      // the final distance cannot be less than score - (n - 1 - j).
      if (score - (n - 1 - j) > maxD) {
        for (let i = 0; i < m; i++) {
          const cp = pat[patStart + i]
          if (cp < 256) peq[cp] = 0
        }
        return INF
      }

      const xhp = ((hp << 1) | 1) >>> 0
      const xhn = (hn << 1) >>> 0
      vp = (xhn | ~(d0 | xhp)) >>> 0
      vn = (xhp & d0) >>> 0
      pmOld = pm
    }

    // Selective cleanup of touched ASCII mask slots (at most 32 writes)
    for (let i = 0; i < m; i++) {
      const cp = pat[patStart + i]
      if (cp < 256) peq[cp] = 0
    }

    return score <= maxD ? score : INF
  }

  /**
   * Fast Bit-Parallel Hyyrö (2003) Kernel specialized for `suggest()` where `slot.peqAscii`
   * has ALREADY been populated once for `slot.bufA[0..m-1]`.
   */
  private bitParallelPreloadedPeq32(
    slot: ScratchSlot,
    m: number,
    hasHighCodePointA: boolean,
    n: number,
    maxD: number,
  ): number {
    const peq = slot.peqAscii
    const pat = slot.bufA
    const txt = slot.bufB

    let vp = m === 32 ? 0xffffffff : (((1 << m) - 1) >>> 0)
    let vn = 0
    let d0 = 0
    let pmOld = 0
    let score = m
    const highBit = (1 << (m - 1)) >>> 0
    const INF = maxD + 1

    for (let j = 0; j < n; j++) {
      const ch = txt[j]
      let pm = 0
      if (ch < 256) {
        pm = peq[ch]
      } else if (hasHighCodePointA) {
        for (let i = 0; i < m; i++) {
          if (pat[i] === ch) pm = (pm | (1 << i)) >>> 0
        }
      }

      const tr = ((((~d0) & pm) << 1) & pmOld) >>> 0
      d0 = (tr | (((pm & vp) + vp) ^ vp) | pm | vn) >>> 0
      const hp = (vn | ~(d0 | vp)) >>> 0
      const hn = (vp & d0) >>> 0

      if ((hp & highBit) !== 0) score++
      else if ((hn & highBit) !== 0) score--

      if (score - (n - 1 - j) > maxD) return INF

      const xhp = ((hp << 1) | 1) >>> 0
      const xhn = (hn << 1) >>> 0
      vp = (xhn | ~(d0 | xhp)) >>> 0
      vn = (xhp & d0) >>> 0
      pmOld = pm
    }

    return score <= maxD ? score : INF
  }

  /**
   * Standard Bounded DP Path: Ukkonen k-bounded 3-row rolling OSA Dynamic Programming
   * inside a single flat pre-allocated Int32Array (`slot.dpFlat`).
   * Zero heap allocations; aborts immediately if `rowMin > maxD`.
   */
  private boundedRowDp(
    slot: ScratchSlot,
    seqA: Int32Array,
    startA: number,
    m: number,
    seqB: Int32Array,
    startB: number,
    n: number,
    maxD: number,
  ): number {
    const INF = maxD + 1
    if (Math.abs(m - n) > maxD) return INF

    slot.ensureCapacity(m > n ? m : n)
    const dp = slot.dpFlat
    const stride = slot.stride

    let prev2Off = 0
    let prev1Off = stride
    let currOff = stride * 2

    const initMaxJ = n < maxD ? n : maxD
    for (let j = 0; j <= initMaxJ; j++) dp[prev1Off + j] = j
    for (let j = initMaxJ + 1; j <= n + 1; j++) dp[prev1Off + j] = INF

    for (let i = 1; i <= m; i++) {
      const startJ = i - maxD > 1 ? i - maxD : 1
      const endJ = i + maxD < n ? i + maxD : n

      dp[currOff] = i <= maxD ? i : INF
      if (startJ > 1) dp[currOff + startJ - 1] = INF
      if (endJ < n) dp[currOff + endJ + 1] = INF

      let rowMin = INF
      const ai1 = seqA[startA + i - 1]
      const ai2 = i > 1 ? seqA[startA + i - 2] : -1

      for (let j = startJ; j <= endJ; j++) {
        const bj1 = seqB[startB + j - 1]
        const cost = ai1 === bj1 ? 0 : 1

        const del = dp[prev1Off + j] + 1
        const ins = dp[currOff + j - 1] + 1
        const sub = dp[prev1Off + j - 1] + cost
        let val = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub

        if (i > 1 && j > 1 && ai1 === seqB[startB + j - 2] && ai2 === bj1) {
          const tr = dp[prev2Off + j - 2] + 1
          if (tr < val) val = tr
        }

        dp[currOff + j] = val
        if (val < rowMin) rowMin = val
      }

      if (rowMin > maxD) return INF

      const tmp = prev2Off
      prev2Off = prev1Off
      prev1Off = currOff
      currOff = tmp
    }

    const result = dp[prev1Off + n]
    return result <= maxD ? result : INF
  }

  /**
   * Finds the best matching candidate(s) from a list of known commands/items.
   * Uses pre-loaded bit-parallel pattern masks when input length <= 32, dynamic
   * similarity-aware distance cutoffs, and pre-allocated top-K registers.
   */
  suggest(
    input: string,
    candidates: readonly string[],
    options?: SuggestOptions,
  ): Suggestion[] {
    const candidateCount = candidates.length
    if (candidateCount === 0) return EMPTY_SUGGESTIONS

    const maxDistance =
      options?.maxDistance !== undefined ? Math.floor(options.maxDistance) : DEFAULT_MAX_DISTANCE
    const minSimilarity =
      options?.minSimilarity !== undefined ? options.minSimilarity : DEFAULT_MIN_SIMILARITY
    const limit =
      options?.limit !== undefined ? Math.max(0, Math.floor(options.limit)) : DEFAULT_LIMIT

    if (limit === 0 || maxDistance < 0) return EMPTY_SUGGESTIONS

    const slot = this.acquireSlot()
    try {
      const lenInput = this.decodeIntoBuffer(input, slot, true)
      if (lenInput === 0) return EMPTY_SUGGESTIONS

      slot.ensureTopCapacity(limit)
      const topIndices = slot.topIndices
      const topDistances = slot.topDistances
      const topSimilarities = slot.topSimilarities
      let topCount = 0

      // Pre-populate 32-bit pattern masks once for `input` if lenInput <= 32
      const usePreloadedPeq = lenInput <= 32
      const peq = slot.peqAscii
      let hasHighCodePointA = false

      if (usePreloadedPeq) {
        const bufA = slot.bufA
        for (let i = 0; i < lenInput; i++) {
          const cp = bufA[i]
          if (cp < 256) {
            peq[cp] = (peq[cp] | (1 << i)) >>> 0
          } else {
            hasHighCodePointA = true
          }
        }
      }

      try {
        for (let cIdx = 0; cIdx < candidateCount; cIdx++) {
          const candidateRaw = candidates[cIdx]
          if (!candidateRaw) continue

          // Fast pre-check on raw string length before decoding when max possible length is too small or too large
          const rawLen = candidateRaw.length
          if (rawLen < lenInput - maxDistance) continue

          const lenCand = this.decodeIntoBuffer(candidateRaw, slot, false)
          if (lenCand === 0) continue

          const maxLen = lenInput >= lenCand ? lenInput : lenCand
          // Derive maximum distance allowed by `minSimilarity`:
          // 1 - (dist / maxLen) >= minSimilarity  <=>  dist <= (1 - minSimilarity) * maxLen
          const simMaxDist = Math.floor((1.0 - minSimilarity) * maxLen + 1e-9)
          let effectiveMaxD = maxDistance < simMaxDist ? maxDistance : simMaxDist

          // If our top-K buffer is already full and the worst item has distance `worstD`,
          // we never need to consider distances > `worstD`!
          if (topCount === limit) {
            const worstD = topDistances[topCount - 1]
            if (worstD < effectiveMaxD) effectiveMaxD = worstD
          }

          if (effectiveMaxD < 0) continue

          const lenDiff = lenInput >= lenCand ? lenInput - lenCand : lenCand - lenInput
          if (lenDiff > effectiveMaxD) continue

          let dist: number
          if (usePreloadedPeq) {
            // Check exact match in O(lenInput) if lenDiff === 0
            if (lenDiff === 0) {
              let identical = true
              const bufA = slot.bufA
              const bufB = slot.bufB
              for (let k = 0; k < lenInput; k++) {
                if (bufA[k] !== bufB[k]) {
                  identical = false
                  break
                }
              }
              dist = identical
                ? 0
                : this.bitParallelPreloadedPeq32(slot, lenInput, hasHighCodePointA, lenCand, effectiveMaxD)
            } else {
              dist = this.bitParallelPreloadedPeq32(
                slot,
                lenInput,
                hasHighCodePointA,
                lenCand,
                effectiveMaxD,
              )
            }
          } else {
            dist = this.computeBufferedDistance(slot, lenInput, lenCand, effectiveMaxD)
          }

          if (dist > effectiveMaxD) continue

          const similarity = 1.0 - dist / maxLen
          if (similarity + 1e-12 < minSimilarity) continue

          // Insert into sorted top-K registers (ordered by distance ASC, similarity DESC)
          let insertPos = topCount
          while (insertPos > 0) {
            const prevDist = topDistances[insertPos - 1]
            const prevSim = topSimilarities[insertPos - 1]
            if (
              dist < prevDist ||
              (dist === prevDist && similarity > prevSim + 1e-12)
            ) {
              insertPos--
            } else {
              break
            }
          }

          if (insertPos >= limit) continue

          const shiftEnd = topCount < limit ? topCount : limit - 1
          for (let s = shiftEnd; s > insertPos; s--) {
            topIndices[s] = topIndices[s - 1]
            topDistances[s] = topDistances[s - 1]
            topSimilarities[s] = topSimilarities[s - 1]
          }

          topIndices[insertPos] = cIdx
          topDistances[insertPos] = dist
          topSimilarities[insertPos] = similarity
          if (topCount < limit) topCount++
        }
      } finally {
        if (usePreloadedPeq) {
          const bufA = slot.bufA
          for (let i = 0; i < lenInput; i++) {
            const cp = bufA[i]
            if (cp < 256) peq[cp] = 0
          }
        }
      }

      if (topCount === 0) return EMPTY_SUGGESTIONS

      const results = new Array<Suggestion>(topCount)
      for (let i = 0; i < topCount; i++) {
        results[i] = {
          candidate: candidates[topIndices[i]],
          distance: topDistances[i],
          similarity: topSimilarities[i],
        }
      }
      return results
    } finally {
      slot.inUse = false
    }
  }
}
