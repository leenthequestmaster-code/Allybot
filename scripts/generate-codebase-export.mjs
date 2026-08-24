import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, extname, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

const repositoryRoot = resolve(process.env.CODEBASE_REPOSITORY_ROOT ?? process.cwd())
const outputArgument = readOption('--output') ?? 'Codebase'
const outputRoot = resolve(repositoryRoot, outputArgument)
const MAX_FILE_BYTES = 1_024 * 1_024
const MAX_TOTAL_SNAPSHOT_BYTES = 8 * 1_024 * 1_024
const MAX_CALL_ROWS = 20_000
const MAX_SYMBOL_ROWS = 50_000

if (outputRoot === repositoryRoot || !isInside(outputRoot, repositoryRoot)) {
  throw new Error('Codebase output must be a child directory of the repository root')
}

const sourceRoots = ['src', 'tests', 'scripts', 'docs', '.github']
const rootFiles = ['README.md', '.env.example', 'package.json', 'package-lock.json', 'tsconfig.json']
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml', '.txt', '.lock'])
const forbiddenPathPattern = /(^|\/)(?:\.env(?!\.example$)|.*\.(?:sqlite|db|pem|key)|creds\.json|credentials\.json|node_modules|dist|Codebase|\.git)(?:\/|$)/i
const secretPatterns = [
  /\b(?:ghp|gho|ghs|ghu|github_pat|sk|xoxb|xapp|gsk|pntl|ptlc|AIza)[_-]?[A-Za-z0-9_-]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|private[_-]?key)\s*[:=]\s*["'`][^"'`\r\n]{16,}["'`]/gi,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*=\s*[A-Za-z0-9_./+=-]{20,}/gi,
]

function readOption(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function isInside(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}

function relativePath(absolutePath) {
  const path = relative(repositoryRoot, absolutePath).split(sep).join('/')
  if (!path || path.startsWith('../') || path === '..') throw new Error(`Path escaped repository root: ${absolutePath}`)
  return path
}

function ensureOutputPath(path) {
  const absolute = resolve(outputRoot, path)
  if (!isInside(absolute, outputRoot)) throw new Error(`Output path escaped Codebase root: ${path}`)
  return absolute
}

function ensureSafeRelativePath(path) {
  const normalized = path.split(sep).join('/')
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..') || /[\u0000-\u001f\u007f]/u.test(normalized)) throw new Error(`Unsafe repository path: ${path}`)
  if (forbiddenPathPattern.test(normalized)) throw new Error(`Forbidden repository path: ${normalized}`)
  return normalized
}

function collectFiles() {
  const files = []
  const visit = (absolutePath) => {
    const entry = statSync(absolutePath, { throwIfNoEntry: false })
    if (!entry) return
    if (entry.isSymbolicLink()) throw new Error(`Symlink is not allowed in Codebase export: ${relativePath(absolutePath)}`)
    if (entry.isDirectory()) {
      for (const child of readdirSync(absolutePath).sort((left, right) => left.localeCompare(right))) visit(resolve(absolutePath, child))
      return
    }
    if (!entry.isFile()) throw new Error(`Unsupported repository entry: ${relativePath(absolutePath)}`)
    const path = ensureSafeRelativePath(relativePath(absolutePath))
    if (!sourceExtensions.has(extname(path).toLowerCase()) && !rootFiles.includes(path)) return
    if (entry.size > MAX_FILE_BYTES) throw new Error(`Source file exceeds ${MAX_FILE_BYTES} byte limit: ${path}`)
    files.push({ path, absolutePath, bytes: entry.size })
  }

  for (const root of sourceRoots) {
    const absolutePath = resolve(repositoryRoot, root)
    if (existsSync(absolutePath)) visit(absolutePath)
  }
  for (const file of rootFiles) {
    const absolutePath = resolve(repositoryRoot, file)
    if (existsSync(absolutePath)) visit(absolutePath)
  }
  return [...new Map(files.map((file) => [file.path, file])).values()].sort((left, right) => left.path.localeCompare(right.path))
}

function readText(record) {
  const content = readFileSync(record.absolutePath, 'utf8')
  if (content.includes('\u0000')) throw new Error(`Binary content is not allowed in Codebase snapshot: ${record.path}`)
  for (const pattern of secretPatterns) {
    pattern.lastIndex = 0
    if (pattern.test(content)) throw new Error(`Secret-like content detected in Codebase source: ${record.path}`)
  }
  return content.replace(/\r\n/g, '\n')
}

function csvCell(value) {
  const text = value === undefined || value === null ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function writeCsv(path, columns, rows) {
  const lines = [columns, ...rows].map((row) => row.map(csvCell).join(','))
  writeText(path, `${lines.join('\n')}\n`)
}

function writeText(path, content) {
  const absolute = ensureOutputPath(path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, content.endsWith('\n') ? content : `${content}\n`, 'utf8')
}

function writeJson(path, value) {
  writeText(path, JSON.stringify(value, null, 2))
}

function lineRange(sourceFile, node) {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1
  return { start, end }
}

function nodeName(node, sourceFile) {
  if (!node.name) return undefined
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) || ts.isNumericLiteral(node.name)) return node.name.text
  return node.name.getText(sourceFile)
}

function nodeKind(node) {
  return ts.SyntaxKind[node.kind] ?? 'Unknown'
}

function hasExportModifier(node) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
}

function scriptKindFor(path) {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (path.endsWith('.json')) return ts.ScriptKind.JSON
  if (path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs')) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function makeSourceFiles(records) {
  return records
    .filter((record) => /\.(?:ts|tsx|js|mjs|cjs)$/.test(record.path))
    .map((record) => ({
      record,
      sourceFile: ts.createSourceFile(record.absolutePath, readText(record), ts.ScriptTarget.Latest, true, scriptKindFor(record.path)),
    }))
}

function sourceFilePath(sourceFile) {
  const absolute = resolve(sourceFile.fileName)
  if (!isInside(absolute, repositoryRoot)) return undefined
  return relativePath(absolute)
}

function getStringValue(node) {
  if (!node) return undefined
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return undefined
}

function getNumberValue(node) {
  if (!node || !ts.isNumericLiteral(node)) return undefined
  const value = Number(node.text)
  return Number.isFinite(value) ? value : undefined
}

function getProperty(object, name) {
  return object.properties.find((property) => {
    const propertyName = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
      ? property.name.text
      : undefined
    return propertyName === name
  })
}

function getStaticArray(node) {
  if (!node || !ts.isArrayLiteralExpression(node)) return []
  return node.elements.map(getStringValue).filter((value) => value !== undefined)
}

function findImportTarget(recordPath, specifier, fileByPath) {
  if (!specifier.startsWith('.')) return `external:${specifier}`
  const absoluteBase = resolve(repositoryRoot, dirname(recordPath), specifier)
  const candidates = [
    absoluteBase,
    `${absoluteBase}.ts`,
    `${absoluteBase}.tsx`,
    `${absoluteBase}.js`,
    `${absoluteBase}.mjs`,
    resolve(absoluteBase, 'index.ts'),
    resolve(absoluteBase, 'index.js'),
  ]
  for (const candidate of candidates) {
    if (!isInside(candidate, repositoryRoot)) continue
    const path = relativePath(candidate)
    if (fileByPath.has(path)) return path
    if (path.endsWith('.js') && fileByPath.has(`${path.slice(0, -3)}.ts`)) return `${path.slice(0, -3)}.ts`
    if (path.endsWith('.mjs') && fileByPath.has(`${path.slice(0, -4)}.ts`)) return `${path.slice(0, -4)}.ts`
  }
  return `unresolved:${specifier}`
}

function importNames(node, sourceFile) {
  const names = []
  if (node.importClause?.name) names.push(`default:${node.importClause.name.text}`)
  const bindings = node.importClause?.namedBindings
  if (bindings && ts.isNamespaceImport(bindings)) names.push(`namespace:${bindings.name.text}`)
  if (bindings && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) names.push(element.propertyName?.text ?? element.name.text)
  }
  if (node.importClause?.isTypeOnly) names.push('type-only')
  if (names.length === 0) names.push('side-effect')
  return names.join('|') || node.moduleSpecifier.getText(sourceFile)
}

function buildSymbols(analysedFiles) {
  const rows = []
  const declarationKinds = new Set([
    ts.SyntaxKind.FunctionDeclaration,
    ts.SyntaxKind.ClassDeclaration,
    ts.SyntaxKind.InterfaceDeclaration,
    ts.SyntaxKind.TypeAliasDeclaration,
    ts.SyntaxKind.EnumDeclaration,
    ts.SyntaxKind.VariableDeclaration,
    ts.SyntaxKind.MethodDeclaration,
    ts.SyntaxKind.GetAccessor,
    ts.SyntaxKind.SetAccessor,
    ts.SyntaxKind.Constructor,
  ])

  for (const { sourceFile } of analysedFiles) {
    const file = sourceFilePath(sourceFile)
    if (!file) continue
    const visit = (node, parent = '') => {
      if (declarationKinds.has(node.kind)) {
        const name = nodeName(node, sourceFile)
        if (name && rows.length < MAX_SYMBOL_ROWS) {
          const range = lineRange(sourceFile, node)
          rows.push([
            file,
            range.start,
            range.end,
            nodeKind(node),
            name,
            hasExportModifier(node) ? 'true' : 'false',
            parent,
          ])
        }
      }
      const name = nodeName(node, sourceFile)
      const nextParent = name && [
        ts.SyntaxKind.ClassDeclaration,
        ts.SyntaxKind.InterfaceDeclaration,
        ts.SyntaxKind.FunctionDeclaration,
        ts.SyntaxKind.MethodDeclaration,
      ].includes(node.kind) ? name : parent
      ts.forEachChild(node, (child) => visit(child, nextParent))
    }
    visit(sourceFile)
  }
  return rows
}

function buildImports(analysedFiles, fileByPath) {
  const rows = []
  for (const { sourceFile } of analysedFiles) {
    const file = sourceFilePath(sourceFile)
    if (!file) continue
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
      const specifier = statement.moduleSpecifier.text
      const range = lineRange(sourceFile, statement)
      rows.push([file, findImportTarget(file, specifier, fileByPath), importNames(statement, sourceFile), range.start, range.end])
    }
  }
  return rows.sort((left, right) => `${left[0]}:${left[1]}`.localeCompare(`${right[0]}:${right[1]}`))
}

function buildDeclaredSymbolIndex(analysedFiles) {
  const index = new Map()
  const declarationKinds = new Set([
    ts.SyntaxKind.FunctionDeclaration,
    ts.SyntaxKind.ClassDeclaration,
    ts.SyntaxKind.InterfaceDeclaration,
    ts.SyntaxKind.TypeAliasDeclaration,
    ts.SyntaxKind.EnumDeclaration,
    ts.SyntaxKind.VariableDeclaration,
    ts.SyntaxKind.MethodDeclaration,
    ts.SyntaxKind.GetAccessor,
    ts.SyntaxKind.SetAccessor,
  ])
  for (const { sourceFile } of analysedFiles) {
    const file = sourceFilePath(sourceFile)
    if (!file) continue
    const visit = (node) => {
      if (declarationKinds.has(node.kind)) {
        const name = nodeName(node, sourceFile)
        if (name) {
          const candidates = index.get(name) ?? []
          candidates.push({ file, name, range: lineRange(sourceFile, node) })
          index.set(name, candidates)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return index
}

function resolveStaticCall(index, expression, sourceFile, currentFile) {
  const name = ts.isIdentifier(expression)
    ? expression.text
    : ts.isPropertyAccessExpression(expression)
      ? expression.name.text
      : undefined
  if (!name) return undefined
  const candidates = index.get(name) ?? []
  return candidates.find((candidate) => candidate.file === currentFile) ?? (candidates.length === 1 ? candidates[0] : undefined)
}

function buildCalls(analysedFiles) {
  const symbolIndex = buildDeclaredSymbolIndex(analysedFiles)
  const rows = []
  for (const { sourceFile } of analysedFiles) {
    const file = sourceFilePath(sourceFile)
    if (!file) continue
    const visit = (node, caller = '<module>') => {
      let nextCaller = caller
      if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
        nextCaller = nodeName(node, sourceFile) ?? caller
      }
      if (ts.isCallExpression(node) && rows.length < MAX_CALL_ROWS) {
        const expression = node.expression.getText(sourceFile)
        const target = resolveStaticCall(symbolIndex, node.expression, sourceFile, file)
        const range = lineRange(sourceFile, node)
        rows.push([
          file,
          caller,
          target?.file ?? `unresolved:${expression}`,
          target?.name ?? expression,
          target ? 'medium' : 'low',
          range.start,
          range.end,
          target ? `${target.file}:${target.range.start}` : '',
        ])
      }
      ts.forEachChild(node, (child) => visit(child, nextCaller))
    }
    visit(sourceFile)
  }
  return rows
}

function buildCommands(analysedFiles) {
  const rows = []
  for (const { sourceFile } of analysedFiles) {
    const file = sourceFilePath(sourceFile)
    if (!file) continue
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'register') {
        const argument = node.arguments[0]
        if (argument && ts.isObjectLiteralExpression(argument)) {
          const name = getStringValue(getProperty(argument, 'name')?.initializer)
          if (name) {
            const aliases = getStaticArray(getProperty(argument, 'aliases')?.initializer).join('|')
            const description = getStringValue(getProperty(argument, 'description')?.initializer) ?? ''
            const category = getStringValue(getProperty(argument, 'category')?.initializer) ?? ''
            const permission = getStringValue(getProperty(argument, 'permission')?.initializer) ?? 'public'
            const cooldown = getNumberValue(getProperty(argument, 'cooldownMs')?.initializer) ?? ''
            const range = lineRange(sourceFile, argument)
            rows.push([file, name, aliases, description, category, permission, cooldown, range.start, range.end])
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return rows.sort((left, right) => left[1].localeCompare(right[1]) || left[0].localeCompare(right[0]))
}

function buildServices(analysedFiles) {
  const rows = []
  for (const { sourceFile } of analysedFiles) {
    const file = sourceFilePath(sourceFile)
    if (!file) continue
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const registration = node.expression.name.text
        if (registration === 'registerService' || registration === 'registerPlugin') {
          const argument = node.arguments[0]
          const expression = argument?.getText(sourceFile) ?? ''
          const name = ts.isNewExpression(argument) && ts.isIdentifier(argument.expression)
            ? argument.expression.text
            : expression.slice(0, 120)
          const range = lineRange(sourceFile, node)
          rows.push([file, registration === 'registerService' ? 'service' : 'plugin', name, range.start, range.end, expression])
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return rows.sort((left, right) => `${left[1]}:${left[2]}`.localeCompare(`${right[1]}:${right[2]}`))
}

function buildConfigCatalog(records) {
  const record = records.find((item) => item.path === 'src/config.ts')
  if (!record) return []
  const rows = []
  const lines = readText(record).split('\n')
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^\s{2}([A-Z][A-Z0-9_]+):\s*(.*)$/)
    if (!match) continue
    const [, name, schema] = match
    const defaultMatch = schema.match(/\.default\(([^)]*)\)/)
    rows.push([
      name,
      schema.replace(/\s+/g, ' ').trim().slice(0, 240),
      defaultMatch?.[1] ?? '',
      schema.includes('.optional()') ? 'optional' : 'required-or-defaulted',
      index + 1,
    ])
  }
  return rows
}

function buildDependencies(records) {
  const record = records.find((item) => item.path === 'package.json')
  if (!record) return []
  const packageJson = JSON.parse(readText(record))
  const rows = []
  for (const [scope, dependencies] of [['production', packageJson.dependencies ?? {}], ['development', packageJson.devDependencies ?? {}]]) {
    for (const [name, version] of Object.entries(dependencies)) rows.push([name, version, scope])
  }
  return rows.sort((left, right) => left[0].localeCompare(right[0]))
}

function buildTests(records) {
  const rows = []
  for (const record of records.filter((item) => item.path.startsWith('tests/'))) {
    const content = readText(record)
    const pattern = /\btest\s*\(\s*(['"`])([\s\S]*?)\1/g
    let match
    while ((match = pattern.exec(content)) !== null) {
      const line = content.slice(0, match.index).split('\n').length
      rows.push([record.path, match[2].replace(/\s+/g, ' ').trim(), record.path.split('/').pop()?.replace(/\.test\.[^.]+$/, '') ?? '', line])
    }
  }
  return rows.sort((left, right) => `${left[0]}:${left[3]}`.localeCompare(`${right[0]}:${right[3]}`))
}

function buildFeatureFlags(configRows) {
  return configRows
    .filter(([name]) => name.endsWith('_ENABLED') || name.endsWith('_FALLBACK_ENABLED'))
    .map(([name, schema, defaultValue, requiredness, line]) => [name, defaultValue, schema, requiredness, line])
}

function buildDataFlow(records, importRows, serviceRows) {
  const files = new Set(records.map((record) => record.path))
  const rows = []
  const add = (from, to, relation, evidence, confidence = 'high') => {
    if (files.has(from) && files.has(to)) rows.push([from, to, relation, evidence, confidence])
  }
  add('src/index.ts', 'src/config.ts', 'loads configuration', 'loadConfig(process.env)', 'high')
  add('src/index.ts', 'src/storage.ts', 'creates operational storage', 'new SqliteStorage(config, logger)', 'high')
  add('src/index.ts', 'src/whatsapp.ts', 'creates WhatsApp adapter', 'new WhatsAppConnection(config, storage, logger, redis)', 'high')
  add('src/index.ts', 'src/framework/application.ts', 'creates application framework', 'new ApplicationFramework(...)', 'high')
  add('src/framework/application.ts', 'src/framework/plugin-manager.ts', 'delegates plugin lifecycle', 'this.plugins.loadAndInitialize/ready/unload', 'high')
  add('src/whatsapp.ts', 'src/storage.ts', 'persists credentials and bounded message cache', 'storage.loadCreds/saveCreds/saveMessages/getMessage', 'high')
  add('src/whatsapp.ts', 'src/upstash-redis.ts', 'uses optional cache', 'redis.cacheGet/cacheSet when enabled', 'high')
  add('src/framework/application.ts', 'src/whatsapp.ts', 'starts and closes transport', 'whatsapp.start/close', 'high')
  for (const [from, to] of importRows.slice(0, 500)) {
    if (!to.startsWith('src/')) continue
    rows.push([from, to, 'module import', 'static import graph', 'high'])
  }
  for (const [file, kind, name] of serviceRows) rows.push([file, name, `registers ${kind}`, 'static registration call', 'high'])
  return [...new Map(rows.map((row) => [row.join('\u0000'), row])).values()]
}

function gitCommitSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

function gitCommitTimestamp(commitSha) {
  try {
    return execFileSync('git', ['show', '-s', '--format=%cI', commitSha], { cwd: repositoryRoot, encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

function listOutputFiles() {
  const files = []
  const visit = (absolutePath) => {
    const entry = statSync(absolutePath)
    if (entry.isDirectory()) {
      for (const child of readdirSync(absolutePath).sort((left, right) => left.localeCompare(right))) visit(resolve(absolutePath, child))
    } else if (entry.isFile()) {
      files.push(relative(outputRoot, absolutePath).split(sep).join('/'))
    }
  }
  visit(outputRoot)
  return files.sort((left, right) => left.localeCompare(right))
}

function sha256(absolutePath) {
  return createHash('sha256').update(readFileSync(absolutePath)).digest('hex')
}

function writeManifest(commitSha, commitTimestamp, records, counts) {
  const outputFiles = listOutputFiles().filter((path) => path !== 'manifest.json' && path !== 'SHA256SUMS.txt')
  const files = outputFiles.map((path) => ({
    path,
    bytes: statSync(ensureOutputPath(path)).size,
    sha256: sha256(ensureOutputPath(path)),
  }))
  writeJson('manifest.json', {
    schemaVersion: 1,
    format: 'allybot-codebase-intelligence-export',
    commitSha,
    generatedAt: commitTimestamp,
    sourceFileCount: records.length,
    counts,
    excluded: ['.env', 'database', 'session', 'raw logs', 'raw chat', 'node_modules', 'dist', 'Codebase'],
    files,
  })
  const checksumPaths = listOutputFiles().filter((path) => path !== 'SHA256SUMS.txt')
  writeText('SHA256SUMS.txt', checksumPaths.map((path) => `${sha256(ensureOutputPath(path))}  ${path}`).join('\n'))
}

function writeOverview(records, counts, commitSha) {
  writeText('README.md', `# Allybot Codebase Intelligence Export\n\nGenerated from commit \`${commitSha}\`. This package is an index-first, read-only map for AI Code and human review. Start with \`overview/project-summary.md\`, then use the CSV tables to locate symbols, imports, calls, commands, services, configuration names, dependencies, tests, and data-flow evidence. Open files under \`snapshot/\` only after the tables identify the relevant boundary.\n\nThe export intentionally excludes .env values, credentials, authentication/session state, databases, raw logs, raw chat content, node_modules, dist, temporary files, symlinks, and the Codebase output itself.\n`)
  writeText('overview/project-summary.md', `# Project Summary\n\nThe export describes Allybot as observed at commit \`${commitSha}\`. It contains ${records.length} allowlisted source/document files, ${counts.symbols} symbol rows, ${counts.imports} import rows, ${counts.calls} call rows, ${counts.commands} command rows, ${counts.services} service/plugin registrations, ${counts.tests} test rows, and ${counts.dependencies} dependency rows.\n\n## Retrieval order\n\nRead the project summary and tree first. Search the command/service/config tables next. Follow imports and calls to identify the smallest relevant source boundary. Read the corresponding snapshot files only after the relationship table provides a path.\n\n## Evidence rule\n\nStatic relationships are marked with a confidence level. A high-confidence row has a resolvable local declaration or an explicit registration pattern. Low-confidence rows are hints that require source confirmation; they are not proof of runtime behavior.\n`)
  writeText('overview/architecture.md', `# Architecture Map\n\nAllybot starts from \`src/index.ts\`, loads validated configuration, creates SQLite operational storage, creates the WhatsApp adapter, registers services and plugins, initializes the framework lifecycle, and starts the WhatsApp transport. The import, call, service, command, and data-flow tables provide the detailed cross-reference.\n\nOperational storage, protocol/session state, feature services, optional external Neon/PostgreSQL and Upstash Redis integrations, and command/plugin boundaries remain separate in the map. This document is a navigation aid; the source snapshot remains authoritative for implementation details.\n`)
  writeText('overview/execution-flow.md', `# Execution Flow\n\n1. \`src/index.ts\` loads configuration and creates the core dependencies.\n2. \`ApplicationFramework\` initializes services and plugins in dependency order.\n3. \`WhatsAppConnection\` starts the Baileys transport and normalizes incoming events.\n4. The framework dispatches commands through prefix, validation, cooldown, and permission checks.\n5. Services persist operational state in their owned storage and optional external integrations remain feature-gated.\n6. Shutdown reverses plugin, transport, and service lifecycle ownership.\n\nUse \`tables/calls.csv\`, \`tables/commands.csv\`, and \`tables/services.csv\` to trace a particular path.\n`)
  writeText('overview/data-flow.md', `# Data Flow and Boundaries\n\nThe data-flow table records static evidence for configuration, WhatsApp transport, SQLite storage, framework lifecycle, optional cache, and registered services/plugins. It deliberately does not include raw message content, credential values, database rows, or session material.\n`)
  writeText('overview/deployment-ci.md', `# CI and Deployment\n\nThe export is generated from source in CI after the repository checkout. CI performs validation before packaging the sanitized deployment artifact. The manifest and SHA256SUMS file provide commit provenance and file integrity. The runtime command \`!codebase\` only delivers the prebuilt ZIP from the allowlisted Codebase directory; it does not scan the server, execute shell commands, or push to GitHub.\n`)
  writeText('overview/known-limitations.md', `# Known Limitations\n\nStatic analysis cannot prove dynamic imports, reflection, runtime dependency injection, generated code, or every indirect call. Unresolved and low-confidence rows are retained as explicit uncertainty rather than guessed relationships. Runtime behavior still requires tests, source review, and deployment evidence.\n`)
}

const sourceCommitSha = readOption('--source-sha') ?? process.env.CODEBASE_SOURCE_COMMIT_SHA ?? gitCommitSha()
if (!/^(?:[a-f0-9]{40}|unknown|local)$/i.test(sourceCommitSha)) throw new Error('Source commit SHA must be a full hexadecimal commit, unknown, or local')

const records = collectFiles()
const contents = records.map((record) => ({ ...record, content: readText(record) }))
const totalSnapshotBytes = contents.reduce((total, record) => total + Buffer.byteLength(record.content), 0)
if (totalSnapshotBytes > MAX_TOTAL_SNAPSHOT_BYTES) throw new Error(`Codebase snapshot exceeds ${MAX_TOTAL_SNAPSHOT_BYTES} byte limit`)

rmSync(outputRoot, { recursive: true, force: true })
mkdirSync(outputRoot, { recursive: true })
for (const record of contents) writeText(`snapshot/${record.path}`, record.content)

const analysedFiles = makeSourceFiles(records)
const fileByPath = new Map(records.map((record) => [record.path, record]))
const importRows = buildImports(analysedFiles, fileByPath)
const symbolRows = buildSymbols(analysedFiles)
const callRows = buildCalls(analysedFiles)
const commandRows = buildCommands(analysedFiles)
const serviceRows = buildServices(analysedFiles)
const configRows = buildConfigCatalog(records)
const dependencyRows = buildDependencies(records)
const testRows = buildTests(records)
const featureFlagRows = buildFeatureFlags(configRows)
const dataFlowRows = buildDataFlow(records, importRows, serviceRows)

writeCsv('tables/files.csv', ['path', 'bytes', 'extension', 'layer', 'snapshot_path'], contents.map((record) => [
  record.path,
  record.bytes,
  extname(record.path).toLowerCase() || 'none',
  record.path.startsWith('src/') ? 'source' : record.path.startsWith('tests/') ? 'test' : record.path.startsWith('docs/') ? 'documentation' : record.path.startsWith('.github/') ? 'ci' : 'root',
  `snapshot/${record.path}`,
]))
writeCsv('tables/symbols.csv', ['file', 'line_start', 'line_end', 'kind', 'name', 'exported', 'parent'], symbolRows)
writeCsv('tables/imports.csv', ['source_file', 'target_file', 'imported_symbols', 'line_start', 'line_end'], importRows)
writeCsv('tables/calls.csv', ['caller_file', 'caller_symbol', 'target_file', 'target_symbol', 'confidence', 'line_start', 'line_end', 'target_evidence'], callRows)
writeCsv('tables/commands.csv', ['file', 'name', 'aliases', 'description', 'category', 'permission', 'cooldown_ms', 'line_start', 'line_end'], commandRows)
writeCsv('tables/services.csv', ['file', 'kind', 'name', 'line_start', 'line_end', 'expression'], serviceRows)
writeCsv('tables/config-catalog.csv', ['name', 'schema', 'default', 'requiredness', 'line'], configRows)
writeCsv('tables/feature-flags.csv', ['name', 'default', 'schema', 'requiredness', 'line'], featureFlagRows)
writeCsv('tables/dependencies.csv', ['name', 'version', 'scope'], dependencyRows)
writeCsv('tables/tests.csv', ['file', 'test_name', 'component_hint', 'line'], testRows)
writeCsv('tables/data-flow.csv', ['from', 'to', 'relation', 'evidence', 'confidence'], dataFlowRows)

const counts = {
  files: records.length,
  symbols: symbolRows.length,
  imports: importRows.length,
  calls: callRows.length,
  commands: commandRows.length,
  services: serviceRows.length,
  config: configRows.length,
  featureFlags: featureFlagRows.length,
  dependencies: dependencyRows.length,
  tests: testRows.length,
  dataFlow: dataFlowRows.length,
}
const commitTimestamp = gitCommitTimestamp(sourceCommitSha)
writeOverview(records, counts, sourceCommitSha)
writeManifest(sourceCommitSha, commitTimestamp, records, counts)
console.log(JSON.stringify({ output: relative(repositoryRoot, outputRoot).split(sep).join('/'), commitSha: sourceCommitSha, counts, snapshotBytes: totalSnapshotBytes }, null, 2))
