import { parentPort, workerData } from 'node:worker_threads'
import { randomInt } from 'node:crypto'

type Token =
  | { type: 'num'; value: number }
  | { type: 'str'; value: string }
  | { type: 'id'; value: string }
  | { type: 'op'; value: string }
  | { type: 'punc'; value: string }

type SandboxTask =
  | { mode: 'eval'; expression: string; variables?: Record<string, number | number[] | string> }
  | { mode: 'dice'; spec: string; iterations?: number; target?: number }
  | { mode: 'table'; rows: Record<string, string | number>[]; sortBy?: string; order?: 'asc' | 'desc'; limit?: number; sumField?: string }

function tokenize(expr: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < expr.length) {
    const ch = expr[i]!
    if (/\s/.test(ch)) { i += 1; continue }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(expr[i + 1] ?? ''))) {
      let j = i + 1
      while (j < expr.length && /[0-9.]/.test(expr[j]!)) j += 1
      const num = Number(expr.slice(i, j))
      if (!Number.isFinite(num)) throw new Error('Invalid number literal')
      tokens.push({ type: 'num', value: num })
      i = j
      continue
    }
    if (ch === '"' || ch === "'") {
      const quote = ch
      let j = i + 1
      let out = ''
      while (j < expr.length && expr[j] !== quote) {
        out += expr[j]
        j += 1
      }
      if (expr[j] !== quote) throw new Error('Unterminated string literal')
      tokens.push({ type: 'str', value: out })
      i = j + 1
      continue
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1
      while (j < expr.length && /[A-Za-z0-9_]/.test(expr[j]!)) j += 1
      tokens.push({ type: 'id', value: expr.slice(i, j) })
      i = j
      continue
    }
    const two = expr.slice(i, i + 2)
    if (['>=', '<=', '==', '!='].includes(two)) {
      tokens.push({ type: 'op', value: two })
      i += 2
      continue
    }
    if ('+-*/%^<>'.includes(ch)) {
      tokens.push({ type: 'op', value: ch })
      i += 1
      continue
    }
    if ('(),[]'.includes(ch)) {
      tokens.push({ type: 'punc', value: ch })
      i += 1
      continue
    }
    throw new Error(`Unsupported token near "${ch}"`)
  }
  return tokens
}

function rollDiceOnce(spec: string): { total: number; rolls: number[]; modifier: number } {
  const m = spec.trim().toLowerCase().match(/^(\d{1,2})d(\d{1,4})([+-]\d{1,5})?$/)
  if (!m) throw new Error('Format dadu harus NdM atau NdM+K, contoh: 2d20+5')
  const count = Number(m[1])
  const sides = Number(m[2])
  const modifier = m[3] ? Number(m[3]) : 0
  if (count < 1 || count > 50 || sides < 2 || sides > 1000) {
    throw new Error('Batas dadu: 1-50 dadu dengan 2-1000 sisi')
  }
  const rolls: number[] = []
  let sum = 0
  for (let i = 0; i < count; i += 1) {
    const r = randomInt(1, sides + 1)
    rolls.push(r)
    sum += r
  }
  return { total: sum + modifier, rolls, modifier }
}

function flattenNumbers(args: unknown[]): number[] {
  const out: number[] = []
  for (const a of args) {
    if (Array.isArray(a)) {
      for (const item of a) {
        if (typeof item !== 'number' || !Number.isFinite(item)) throw new Error('Array harus berisi angka')
        out.push(item)
      }
    } else if (typeof a === 'number' && Number.isFinite(a)) {
      out.push(a)
    } else {
      throw new Error('Argumen numerik tidak valid')
    }
  }
  if (out.length === 0) throw new Error('Daftar angka kosong')
  return out
}

function evalExpression(expression: string, variables: Record<string, unknown>): unknown {
  const tokens = tokenize(expression)
  let pos = 0
  const peek = () => tokens[pos]
  const consume = () => tokens[pos++]

  function parseCmp(): unknown {
    let left = parseAdd()
    while (peek()?.type === 'op' && ['>', '<', '>=', '<=', '==', '!='].includes(peek()!.value as string)) {
      const op = consume()!.value as string
      const right = parseAdd()
      const l = Number(left), r = Number(right)
      if (op === '>') left = l > r ? 1 : 0
      else if (op === '<') left = l < r ? 1 : 0
      else if (op === '>=') left = l >= r ? 1 : 0
      else if (op === '<=') left = l <= r ? 1 : 0
      else if (op === '==') left = left === right ? 1 : 0
      else left = left !== right ? 1 : 0
    }
    return left
  }

  function parseAdd(): unknown {
    let left = parseMul()
    while (peek()?.type === 'op' && (peek()!.value === '+' || peek()!.value === '-')) {
      const op = consume()!.value
      const right = parseMul()
      left = op === '+' ? Number(left) + Number(right) : Number(left) - Number(right)
    }
    return left
  }

  function parseMul(): unknown {
    let left = parsePow()
    while (peek()?.type === 'op' && ['*', '/', '%'].includes(peek()!.value as string)) {
      const op = consume()!.value
      const right = parsePow()
      if (op === '*') left = Number(left) * Number(right)
      else if (op === '/') {
        const d = Number(right)
        if (d === 0) throw new Error('Division by zero')
        left = Number(left) / d
      } else {
        left = Number(left) % Number(right)
      }
    }
    return left
  }

  function parsePow(): unknown {
    const base = parseUnary()
    if (peek()?.type === 'op' && peek()!.value === '^') {
      consume()
      const exp = parsePow()
      return Math.pow(Number(base), Number(exp))
    }
    return base
  }

  function parseUnary(): unknown {
    if (peek()?.type === 'op' && peek()!.value === '-') {
      consume()
      return -Number(parseUnary())
    }
    if (peek()?.type === 'op' && peek()!.value === '+') {
      consume()
      return Number(parseUnary())
    }
    return parsePrimary()
  }

  function parsePrimary(): unknown {
    const tok = peek()
    if (!tok) throw new Error('Unexpected end of expression')
    if (tok.type === 'num' || tok.type === 'str') {
      consume()
      return tok.value
    }
    if (tok.type === 'punc' && tok.value === '(') {
      consume()
      const val = parseCmp()
      if (consume()?.value !== ')') throw new Error('Expected ")"')
      return val
    }
    if (tok.type === 'punc' && tok.value === '[') {
      consume()
      const items: unknown[] = []
      while (peek() && !(peek()!.type === 'punc' && peek()!.value === ']')) {
        items.push(parseCmp())
        if (peek()?.type === 'punc' && peek()!.value === ',') consume()
      }
      if (consume()?.value !== ']') throw new Error('Expected "]"')
      return items
    }
    if (tok.type === 'id') {
      consume()
      const name = tok.value
      if (peek()?.type === 'punc' && peek()!.value === '(') {
        consume()
        const args: unknown[] = []
        while (peek() && !(peek()!.type === 'punc' && peek()!.value === ')')) {
          args.push(parseCmp())
          if (peek()?.type === 'punc' && peek()!.value === ',') consume()
        }
        if (consume()?.value !== ')') throw new Error('Expected ")" after arguments')
        return callFn(name.toLowerCase(), args)
      }
      if (name === 'pi' || name === 'PI') return Math.PI
      if (name === 'e' || name === 'E') return Math.E
      if (Object.prototype.hasOwnProperty.call(variables, name)) return variables[name]
      throw new Error(`Unknown variable: ${name}`)
    }
    throw new Error('Unexpected token')
  }

  function callFn(fn: string, args: unknown[]): unknown {
    switch (fn) {
      case 'sum': return flattenNumbers(args).reduce((a, b) => a + b, 0)
      case 'avg': {
        const nums = flattenNumbers(args)
        return nums.reduce((a, b) => a + b, 0) / nums.length
      }
      case 'min': return Math.min(...flattenNumbers(args))
      case 'max': return Math.max(...flattenNumbers(args))
      case 'median': {
        const sorted = flattenNumbers(args).sort((a, b) => a - b)
        const mid = Math.floor(sorted.length / 2)
        return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
      }
      case 'round': return Number(Number(args[0]).toFixed(args[1] !== undefined ? Math.min(6, Math.max(0, Number(args[1]))) : 0))
      case 'floor': return Math.floor(Number(args[0]))
      case 'ceil': return Math.ceil(Number(args[0]))
      case 'sqrt': return Math.sqrt(Number(args[0]))
      case 'abs': return Math.abs(Number(args[0]))
      case 'pow': return Math.pow(Number(args[0]), Number(args[1]))
      case 'pct': return (Number(args[0]) / Number(args[1])) * 100
      case 'if': return args[0] ? args[1] : args[2]
      case 'roll': return rollDiceOnce(String(args[0] ?? '1d20')).total
      default: throw new Error(`Fungsi tidak diizinkan: ${fn}`)
    }
  }

  const result = parseCmp()
  if (pos < tokens.length) throw new Error('Unexpected trailing tokens')
  return result
}

try {
  const task = workerData as SandboxTask
  if (task.mode === 'eval') {
    const value = evalExpression(task.expression, task.variables ?? {})
    parentPort?.postMessage({ ok: true, result: value })
  } else if (task.mode === 'dice') {
    const iters = Math.min(Math.max(Number(task.iterations ?? 1), 1), 10_000)
    if (iters === 1) {
      const single = rollDiceOnce(task.spec)
      parentPort?.postMessage({
        ok: true,
        result: {
          spec: task.spec,
          ...single,
          ...(typeof task.target === 'number' ? { success: single.total >= task.target } : {}),
        },
      })
    } else {
      let sum = 0
      let min = Infinity
      let max = -Infinity
      let hits = 0
      for (let i = 0; i < iters; i += 1) {
        const t = rollDiceOnce(task.spec).total
        sum += t
        if (t < min) min = t
        if (t > max) max = t
        if (typeof task.target === 'number' && t >= task.target) hits += 1
      }
      parentPort?.postMessage({
        ok: true,
        result: {
          spec: task.spec,
          iterations: iters,
          avg: Number((sum / iters).toFixed(3)),
          min,
          max,
          ...(typeof task.target === 'number'
            ? { target: task.target, successCount: hits, successRatePct: Number(((hits / iters) * 100).toFixed(2)) }
            : {}),
        },
      })
    }
  } else if (task.mode === 'table') {
    const rows = Array.isArray(task.rows) ? task.rows.slice(0, 500) : []
    const dir = task.order === 'asc' ? 1 : -1
    const sorted = task.sortBy
      ? [...rows].sort((a, b) => {
          const av = a[task.sortBy!] ?? 0
          const bv = b[task.sortBy!] ?? 0
          if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
          return String(av).localeCompare(String(bv)) * dir
        })
      : rows
    const top = sorted.slice(0, Math.min(task.limit ?? 20, 50))
    const sumValue = task.sumField
      ? rows.reduce((acc, r) => acc + (typeof r[task.sumField!] === 'number' ? Number(r[task.sumField!]) : 0), 0)
      : undefined
    parentPort?.postMessage({
      ok: true,
      result: { count: rows.length, rows: top, ...(sumValue !== undefined ? { sumField: task.sumField, sumValue } : {}) },
    })
  } else {
    parentPort?.postMessage({ ok: false, error: 'Unsupported sandbox mode' })
  }
} catch (error) {
  parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : 'Sandbox computation failed' })
}
