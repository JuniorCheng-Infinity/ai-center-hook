import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { logWarning, parseJson, resolveDirs } from '../hook-utils.mjs'

// What each client calls itself. The backend maps these names to its client types, so they must not change.
export const PLATFORM = {
	claudeCode: 'claude-code',
	codex: 'codex-mcp-client'
}

// A Codex hook signal outranks CLAUDECODE, which a Codex started from a Claude Code shell inherits.
export function detectPlatform() {
	const pluginRoot = process.env.PLUGIN_ROOT ?? process.env.CLAUDE_PLUGIN_ROOT ?? ''
	const codexHook = (process.env.PLUGIN_ROOT && process.env.PLUGIN_DATA) || /\.codex[\\/]/.test(pluginRoot)
	const claudeHook = process.env.CLAUDE_PROJECT_DIR
	if (codexHook && !claudeHook) return PLATFORM.codex
	if (process.env.CLAUDECODE) return PLATFORM.claudeCode
	if (codexHook) return PLATFORM.codex
	return undefined
}

// Finds the nearest ancestor (inclusive) containing `.git`, or undefined if `startDir` isn't inside a git repo at all.
function findRepoRoot(startDir) {
	let dir = startDir
	while (true) {
		if (existsSync(join(dir, '.git'))) return dir
		if (dir === homedir()) return undefined
		const parent = dirname(dir)
		if (parent === dir) return undefined
		dir = parent
	}
}

// Walks from `startDir` up to `boundary`, calling `check(dir)` at each level until one returns truthy.
function searchUpTo(startDir, boundary, check) {
	let dir = startDir
	while (true) {
		const result = check(dir)
		if (result) return result
		if (dir === boundary) return undefined
		dir = dirname(dir)
	}
}

// Climbing is only trusted inside a git repo, so a stray registration on a shared parent is never picked up.
export function findRegisteredAncestor(config, startDir) {
	const check = (dir) => config.projects?.[dir]?.mcpServers?.['ai-center']
	const repoRoot = findRepoRoot(startDir)
	if (!repoRoot) return check(startDir)
	return searchUpTo(startDir, repoRoot, check)
}

// The one place a stored MCP server entry becomes a connection, for both clients.
// The key may come with or without its "Bearer " prefix, and the short /mcp suffix and the old
// /api/client/mcp one give the same bare origin.
export function buildConnection(url, authorization) {
	const apiKey = typeof authorization === 'string' ? authorization.replace(/^Bearer\s+/i, '') : undefined
	if (typeof url !== 'string' || !url || !apiKey) return undefined
	return { baseUrl: url.replace(/\/(?:api\/client\/)?mcp\/?$/, ''), apiKey }
}

// The one sentence for a config file that could not be read, naming the file and the reason, never its contents.
const formatUnreadableConfig = (configPath, reason) => `ai-center config ${configPath} could not be read (${reason}).`

// The text of a config file, or a thrown message that names the file and the error code, never its contents.
function readConfigText(configPath) {
	try {
		return readFileSync(configPath, 'utf8')
	} catch (error) {
		throw new Error(formatUnreadableConfig(configPath, error.code ?? 'unknown error'))
	}
}

// A missing file or registration is routine; anything broken or incomplete throws.
function readClaudeCodeConnection(cwd) {
	const configPath = join(homedir(), '.claude.json')
	if (!existsSync(configPath)) return undefined
	const config = parseJson(readConfigText(configPath))
	if (!config) throw new Error(formatUnreadableConfig(configPath, 'it is not valid JSON'))
	const server = findRegisteredAncestor(config, cwd)
	if (!server) return undefined
	const authorization = server.headers?.Authorization
	if ([server.url, authorization].some((value) => typeof value === 'string' && value.includes('${'))) {
		throw new Error(
			`[ai-center] registration in ${configPath} holds a \${...} placeholder, which the hooks do not expand. ` +
				'Write the key into the header, as the README shows.',
		)
	}
	const connection = buildConnection(server.url, authorization)
	if (connection) return connection
	throw new Error(`[ai-center] registration in ${configPath} needs a url and an Authorization header.`)
}

export const ATTEMPT_TIMEOUT_MS = 2_000
export const SEARCH_TIMEOUT_MS = 5_000

// The exit status of the program below when tomllib cannot be imported, after it prints its Python version.
const NO_TOMLLIB_STATUS = 3
// The exit status of the program below when the TOML text is invalid.
const INVALID_TOML_STATUS = 4

// Reads TOML from stdin as UTF-8, skipping a leading BOM, and prints it as JSON with floats and dates as text.
const PARSE_CODE = [
	'import sys, json',
	'try: import tomllib',
	`except ImportError: print(*sys.version_info[:2]); sys.exit(${NO_TOMLLIB_STATUS})`,
	'try: config = tomllib.loads(sys.stdin.buffer.read().decode("utf-8-sig"), parse_float=str)',
	`except tomllib.TOMLDecodeError: sys.exit(${INVALID_TOML_STATUS})`,
	'print(json.dumps(config, default=str))',
].join('\n')

// The Windows launcher first, then the ordinary executable names.
const WINDOWS_PYTHON_CANDIDATES = [
	{ command: 'py', args: ['-3'] },
	{ command: 'python', args: [] },
	{ command: 'python3', args: [] },
]

function listVersionedPythons(env) {
	const minors = new Map()
	for (const folder of (env.PATH ?? '').split(delimiter)) {
		let names = []
		try {
			names = readdirSync(folder)
		} catch (error) {
			// A missing folder is routine and silent, and any other problem is logged.
			if (error.code !== 'ENOENT') logWarning(`PATH folder ${folder} could not be listed`, error)
		}
		for (const name of names) {
			const minor = /^python3\.(\d+)$/.exec(name)?.[1]
			if (minor) minors.set(name, Number(minor))
		}
	}
	return [...minors.keys()].sort((a, b) => minors.get(b) - minors.get(a))
}

const buildCandidate = (command) => ({ command, args: [] })

// A generator, so the PATH folders are only listed after python3 has failed.
function* buildCandidates(platform, env) {
	if (platform === 'win32') {
		yield* WINDOWS_PYTHON_CANDIDATES
		return
	}
	yield buildCandidate('python3')
	for (const name of listVersionedPythons(env)) yield buildCandidate(name)
	yield buildCandidate('python')
}

const formatLaunchProblem = (command, error) =>
	`${command}: ${error.code === 'ETIMEDOUT' ? 'timed out' : (error.code ?? 'could not start')}`

const formatExitProblem = (command, result) => `${command}: exited with status ${result.status ?? result.signal}`

function formatPythonProblems(problems) {
	return `Python could not be run (${problems.join('; ')}). Check that it starts, or install Python 3.11 or newer.`
}

function formatMissingPython(problems, versionsWithoutTomllib) {
	const tried = versionsWithoutTomllib.length
		? `No Python with a working tomllib was found (tried ${versionsWithoutTomllib.join(', ')}). `
		: ''
	if (problems.length) return tried + formatPythonProblems(problems)
	if (tried) return tried + 'Python 3.11 or newer is required; install it and make sure it is on PATH.'
	return 'Python was not found. Install Python 3.11 or newer and make sure it is on PATH.'
}

function runPython({ command, args }, code, { env, spawn, timeout, input }) {
	// Stops the Windows Python install manager from downloading a Python when a launch finds none.
	// -I keeps a tomllib.py or json.py in the project folder from being imported.
	return spawn(command, [...args, '-I', '-c', code], {
		input,
		encoding: 'utf8',
		env: { ...env, PYTHON_MANAGER_AUTOMATIC_INSTALL: '0' },
		timeout,
		windowsHide: true,
	})
}

function tryPython(candidate, text, settings) {
	const result = runPython(candidate, PARSE_CODE, { ...settings, input: text })
	// A Python that is not installed is skipped without a problem.
	if (result.error?.code === 'ENOENT') return {}
	if (result.error) return { problem: formatLaunchProblem(candidate.command, result.error) }
	if (result.status === INVALID_TOML_STATUS) return { invalidToml: true }
	const version = /^(\d+) (\d+)/.exec(result.stdout ?? '')
	if (result.status === NO_TOMLLIB_STATUS && version) return { versionWithoutTomllib: `${version[1]}.${version[2]}` }
	if (result.status !== 0) return { problem: formatExitProblem(candidate.command, result) }
	const config = parseJson(result.stdout)
	return config ? { config } : { problem: `${candidate.command}: returned output it could not read` }
}

function findPython(candidates, text, { env, spawn, now, searchTimeoutMs }) {
	const deadline = now() + searchTimeoutMs
	const problems = []
	const versionsWithoutTomllib = []
	for (const candidate of candidates) {
		const remaining = deadline - now()
		if (remaining <= 0) {
			problems.push(`the search stopped after ${searchTimeoutMs / 1000} s`)
			break
		}
		const found = tryPython(candidate, text, { env, spawn, timeout: Math.min(ATTEMPT_TIMEOUT_MS, remaining) })
		if (found.config || found.invalidToml) return { python: candidate, ...found }
		if (found.problem) problems.push(found.problem)
		if (found.versionWithoutTomllib) versionsWithoutTomllib.push(found.versionWithoutTomllib)
	}
	throw new Error(formatMissingPython(problems, versionsWithoutTomllib))
}

// The first parse finds a working Python; later parses reuse it.
export function createTomlParser({
	platform = process.platform,
	env = process.env,
	spawn = spawnSync,
	now = Date.now,
	searchTimeoutMs = SEARCH_TIMEOUT_MS,
} = {}) {
	let python
	return (text) => {
		const candidates = python ? [python] : buildCandidates(platform, env)
		const found = findPython(candidates, text, { env, spawn, now, searchTimeoutMs })
		python = found.python
		if (found.invalidToml) throw new Error('It is not valid TOML. Fix its syntax.')
		return found.config
	}
}

let parseToml = createTomlParser()

// A short hook calls this first, so the Python search cannot outlast the hook.
export function limitSearchTime(searchTimeoutMs) {
	parseToml = createTomlParser({ searchTimeoutMs })
}

// A broken file throws a message that never repeats its contents.
function readConfigTomlConnection(configPath) {
	if (!existsSync(configPath)) return undefined
	const text = readConfigText(configPath)
	let config
	try {
		config = parseToml(text)
	} catch (error) {
		throw new Error(`ai-center config ${configPath} was not read. ${error.message}`)
	}
	const server = config.mcp_servers?.['ai-center']
	return server === undefined ? undefined : serverToConnection(server, configPath)
}

// A repo's config may only name variables with this prefix, so it cannot make the hooks read an unrelated secret.
const TOKEN_VARIABLE_PREFIX = 'AI_CENTER_'

// Codex can name an environment variable that holds the key instead of writing the header out.
function serverToConnection(server, configPath) {
	const tokenVariable = server.bearer_token_env_var
	if (tokenVariable && !String(tokenVariable).startsWith(TOKEN_VARIABLE_PREFIX)) {
		throw new Error(
			`[mcp_servers.ai-center] in ${configPath} names a bearer_token_env_var ` +
				`that does not start with ${TOKEN_VARIABLE_PREFIX}.`,
		)
	}
	const authorization = tokenVariable ? process.env[tokenVariable] : server.http_headers?.Authorization
	const connection = buildConnection(server.url, authorization)
	if (connection) return connection
	const missing = typeof server.url === 'string' && server.url
		? 'bearer_token_env_var naming a set environment variable, or http_headers.Authorization'
		: 'a url'
	throw new Error(`[mcp_servers.ai-center] in ${configPath} needs ${missing}.`)
}

// Removes the [mcp_servers.ai-center] table and its sub-tables from raw TOML and leaves the rest untouched.
function stripExistingAiCenterSection(text) {
	const kept = []
	let skipping = false
	for (const line of text.split('\n')) {
		const header = /^\[([^\]]+)\]/.exec(line.trim())
		if (header) {
			skipping = header[1] === 'mcp_servers.ai-center' || header[1].startsWith('mcp_servers.ai-center.')
		}
		if (!skipping) kept.push(line)
	}
	return kept.join('\n')
}

// Merges the [mcp_servers.ai-center] table into <dir>/.codex/config.toml, which Codex prefers over the global file.
export function writeCodexProjectConnection(dir, { baseUrl, apiKey }) {
	const configPath = join(dir, '.codex', 'config.toml')
	mkdirSync(join(dir, '.codex'), { recursive: true })
	const existing = existsSync(configPath) ? readFileSync(configPath, 'utf8') : ''
	const withoutOldSection = stripExistingAiCenterSection(existing).replace(/\n+$/, '')
	const section = [
		'[mcp_servers.ai-center]',
		`url = "${baseUrl.replace(/\/$/, '')}/mcp"`,
		'',
		'[mcp_servers.ai-center.http_headers]',
		`Authorization = "Bearer ${apiKey}"`,
		'',
	].join('\n')
	writeFileSync(configPath, withoutOldSection ? `${withoutOldSection}\n\n${section}` : section)
	return configPath
}

// The project-local config.toml is bounded by .git and wins over the global file.
function readCodexConnection(dir) {
	const check = (level) => readConfigTomlConnection(join(level, '.codex', 'config.toml'))
	const repoRoot = findRepoRoot(dir)
	const projectConnection = repoRoot ? searchUpTo(dir, repoRoot, check) : check(dir)
	const globalConfigPath = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml')
	return projectConnection ?? readConfigTomlConnection(globalConfigPath)
}

// For an unknown client a broken source is logged and skipped, and its problem is thrown only if no source works.
function findFirstConnection(readers) {
	let firstProblem
	for (const read of readers) {
		try {
			const connection = read()
			if (connection) return connection
		} catch (error) {
			logWarning('ai-center connection source skipped', error)
			firstProblem ??= error
		}
	}
	if (firstProblem) throw firstProblem
	return undefined
}

function readConnectionForPlatform(platform, { cwd, projectDir }) {
	if (platform === PLATFORM.claudeCode) {
		return readClaudeCodeConnection(projectDir) ?? (cwd !== projectDir ? readClaudeCodeConnection(cwd) : undefined)
	}
	if (platform === PLATFORM.codex) {
		return readCodexConnection(projectDir) ?? (cwd !== projectDir ? readCodexConnection(cwd) : undefined)
	}
	const readers = [() => readCodexConnection(projectDir), () => readClaudeCodeConnection(projectDir)]
	if (cwd !== projectDir) readers.push(() => readCodexConnection(cwd), () => readClaudeCodeConnection(cwd))
	return findFirstConnection(readers)
}

export function resolveConnection({ cwd, projectDir }) {
	const envBaseUrl = process.env.AI_CENTER_BASE_URL
	const envApiKey = process.env.AI_CENTER_API_KEY
	if (envBaseUrl && envApiKey) return { baseUrl: envBaseUrl.replace(/\/$/, ''), apiKey: envApiKey }

	const discovered = readConnectionForPlatform(detectPlatform(), { cwd, projectDir })
	if (discovered) return discovered

	throw new Error(
		'ai-center connection not found: set AI_CENTER_BASE_URL and AI_CENTER_API_KEY, ' +
			'or configure ai-center in Codex config.toml (requires Python 3.11+) or Claude Code',
	)
}

// How a hook finds its connection: the directories come from the hook's own input.
export function resolveHookConnection(input) {
	return resolveConnection(resolveDirs(input))
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const baseUrl = process.env.AI_CENTER_BASE_URL
	const apiKey = process.env.AI_CENTER_API_KEY

	if (!baseUrl || !apiKey) {
		console.error('Set AI_CENTER_BASE_URL and AI_CENTER_API_KEY first.')
		process.exit(1)
	}
	console.log(writeCodexProjectConnection(process.cwd(), { baseUrl, apiKey }))
}
