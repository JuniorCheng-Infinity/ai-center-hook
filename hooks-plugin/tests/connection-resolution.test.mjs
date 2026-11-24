import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findRegisteredAncestor, writeCodexProjectConnection, resolveConnection } from '../scripts/lib/connection/client-connections.mjs'
import { NO_PYTHON_REASON } from './real-python.mjs'

// Tests that read a config.toml need a Python 3.11+, and are skipped on a machine without one.
const NEEDS_PYTHON = { skip: NO_PYTHON_REASON }

test('findRegisteredAncestor walks up within a repo but never past its .git boundary', () => {
	const root = mkdtempSync(join(tmpdir(), 'ai-center-conn-test-'))
	try {
		const repo = join(root, 'repo')
		const backend = join(repo, 'backend')
		const deep = join(backend, 'deep')
		const otherRepo = join(root, 'other-repo')
		for (const dir of [repo, backend, deep, otherRepo]) mkdirSync(dir, { recursive: true })
		mkdirSync(join(repo, '.git'))
		mkdirSync(join(otherRepo, '.git'))

		const server = { url: 'http://test.invalid/mcp', headers: { Authorization: 'Bearer test-key' } }
		const config = { projects: { [repo]: { mcpServers: { 'ai-center': server } } } }

		assert.deepEqual(findRegisteredAncestor(config, repo), server)
		assert.deepEqual(findRegisteredAncestor(config, backend), server)
		assert.deepEqual(findRegisteredAncestor(config, deep), server)
		assert.equal(findRegisteredAncestor(config, otherRepo), undefined)

		// A registration on a shared parent that merely contains the repo must
		// never be picked up from inside the repo — the .git boundary at `repo`
		// stops the walk before it could ever reach `root`.
		const strayConfig = { projects: { [root]: { mcpServers: { 'ai-center': server } } } }
		assert.equal(findRegisteredAncestor(strayConfig, backend), undefined)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('findRegisteredAncestor never climbs outside a git repo at all', () => {
	const root = mkdtempSync(join(tmpdir(), 'ai-center-conn-test-nogit-'))
	try {
		const parent = join(root, 'scratch')
		const child = join(parent, 'nested')
		mkdirSync(child, { recursive: true }) // no .git anywhere under root

		const server = { url: 'http://test.invalid/mcp', headers: { Authorization: 'Bearer test-key' } }

		// Registered at the exact starting directory: always trusted, git or not.
		const exactConfig = { projects: { [child]: { mcpServers: { 'ai-center': server } } } }
		assert.deepEqual(findRegisteredAncestor(exactConfig, child), server)

		// Registered one level up, but with no .git anywhere: must NOT be found —
		// there is no boundary proving `child` and `parent` belong together.
		const ancestorConfig = { projects: { [parent]: { mcpServers: { 'ai-center': server } } } }
		assert.equal(findRegisteredAncestor(ancestorConfig, child), undefined)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('writeCodexProjectConnection merges without disturbing unrelated settings', () => {
	const dir = mkdtempSync(join(tmpdir(), 'ai-center-codex-write-test-'))
	try {
		writeCodexProjectConnection(dir, { baseUrl: 'http://first.invalid', apiKey: 'key-one' })
		let content = readFileSync(join(dir, '.codex', 'config.toml'), 'utf8')
		assert.match(content, /url = "http:\/\/first\.invalid\/mcp"/)
		assert.match(content, /Authorization = "Bearer key-one"/)

		// Add an unrelated setting by hand, the way a user's own config would have it.
		writeFileSync(join(dir, '.codex', 'config.toml'), `[model]\nname = "o3"\n\n${content}`)

		// Overwrite with a new connection: old ai-center section replaced, model setting survives.
		writeCodexProjectConnection(dir, { baseUrl: 'http://second.invalid', apiKey: 'key-two' })
		content = readFileSync(join(dir, '.codex', 'config.toml'), 'utf8')
		assert.match(content, /name = "o3"/)
		assert.match(content, /url = "http:\/\/second\.invalid\/mcp"/)
		assert.match(content, /Authorization = "Bearer key-two"/)
		assert.doesNotMatch(content, /first\.invalid/)
		assert.doesNotMatch(content, /key-one/)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test('resolveConnection prefers a project-local Codex config over the global one, bounded by .git', NEEDS_PYTHON, () => {
	const root = mkdtempSync(join(tmpdir(), 'ai-center-codex-walk-test-'))
	try {
		const repo = join(root, 'repo')
		const nested = join(repo, 'nested')
		mkdirSync(nested, { recursive: true })
		mkdirSync(join(repo, '.git'))

		const codexHome = join(root, 'codex-home')
		mkdirSync(codexHome, { recursive: true })
		writeFileSync(join(codexHome, 'config.toml'), '[mcp_servers.ai-center]\nurl = "http://global.invalid/mcp"\n\n[mcp_servers.ai-center.http_headers]\nAuthorization = "Bearer global-key"\n')

		writeCodexProjectConnection(repo, { baseUrl: 'http://project-local.invalid', apiKey: 'project-key' })

		const env = { ...process.env, PLUGIN_ROOT: '/fake/.codex/plugins/cache/x', CODEX_HOME: codexHome }
		delete env.CLAUDECODE
		delete env.AI_CENTER_BASE_URL
		delete env.AI_CENTER_API_KEY
		const originalEnv = { ...process.env }
		Object.assign(process.env, env)
		for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]
		try {
			// From the repo root and from a nested subdirectory: both find the project-local file.
			assert.deepEqual(resolveConnection({ cwd: repo, projectDir: repo }), { baseUrl: 'http://project-local.invalid', apiKey: 'project-key' })
			assert.deepEqual(resolveConnection({ cwd: nested, projectDir: nested }), { baseUrl: 'http://project-local.invalid', apiKey: 'project-key' })
			// Outside any repo with a project-local file: falls back to the global one.
			assert.deepEqual(resolveConnection({ cwd: root, projectDir: root }), { baseUrl: 'http://global.invalid', apiKey: 'global-key' })
		} finally {
			for (const key of Object.keys(process.env)) delete process.env[key]
			Object.assign(process.env, originalEnv)
		}
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

const CODEX_PLUGIN_ROOT = '/fake/.codex/plugins/cache/x'
const PROJECT_SECRET = 'project-secret-key'
const GLOBAL_SECRET = 'global-key'
const GLOBAL_CONNECTION = { baseUrl: 'http://global.invalid', apiKey: GLOBAL_SECRET }
const GLOBAL_TOML = '[mcp_servers.ai-center]\nurl = "http://global.invalid/mcp"\n\n' +
	`[mcp_servers.ai-center.http_headers]\nAuthorization = "Bearer ${GLOBAL_SECRET}"\n`
// Not valid TOML (the table header is never closed), and it holds a key that must never be printed.
const BROKEN_PROJECT_TOML = '[mcp_servers.ai-center\nurl = "http://project.invalid/mcp"\n' +
	`Authorization = "Bearer ${PROJECT_SECRET}"\n`

function buildTempRoot(t) {
	const root = mkdtempSync(join(tmpdir(), 'ai-center-codex-test-'))
	t.after(() => rmSync(root, { recursive: true, force: true }))
	return root
}

// A repo (with its .git) and an empty CODEX_HOME; each test writes the config.toml files it needs.
function buildCodexRepo(root) {
	const repo = join(root, 'repo')
	const codexHome = join(root, 'codex-home')
	mkdirSync(join(repo, '.git'), { recursive: true })
	mkdirSync(join(repo, '.codex'))
	mkdirSync(codexHome)
	return {
		repo,
		codexHome,
		projectConfig: join(repo, '.codex', 'config.toml'),
		globalConfig: join(codexHome, 'config.toml'),
	}
}

// Runs `run` with the environment a Codex hook sees, then puts the real environment back.
function runAsCodexHook(codexHome, run) {
	const originalEnv = { ...process.env }
	for (const key of ['CLAUDECODE', 'AI_CENTER_BASE_URL', 'AI_CENTER_API_KEY']) delete process.env[key]
	process.env.PLUGIN_ROOT = CODEX_PLUGIN_ROOT
	process.env.CODEX_HOME = codexHome
	try {
		return run()
	} finally {
		for (const key of Object.keys(process.env)) delete process.env[key]
		Object.assign(process.env, originalEnv)
	}
}

const resolveIn = (repo) => () => resolveConnection({ cwd: repo, projectDir: repo })

// Passes when `run` throws a message that matches `expected`, holds `mustInclude`, and shows no key.
function assertFailsWith(run, expected, mustInclude = '') {
	assert.throws(run, (error) => {
		assert.match(error.message, expected)
		assert.ok(error.message.includes(mustInclude))
		assert.doesNotMatch(error.message, new RegExp(`${PROJECT_SECRET}|${GLOBAL_SECRET}|${CLAUDE_SECRET}`))
		return true
	})
}

const CLAUDE_SECRET = 'claude-secret-key'
const CLAUDE_SERVER = { url: 'http://claude.invalid/mcp', headers: { Authorization: `Bearer ${CLAUDE_SECRET}` } }
const CLAUDE_CONNECTION = { baseUrl: 'http://claude.invalid', apiKey: CLAUDE_SECRET }
// The environment variables each client gives its hooks; an unknown client gives none.
const CODEX_CLIENT = { PLUGIN_ROOT: CODEX_PLUGIN_ROOT, PLUGIN_DATA: '/fake/data' }
const CLAUDE_CLIENT = { CLAUDECODE: '1' }
const UNKNOWN_CLIENT = {}
const CLIENT_ENV_NAMES = ['CLAUDECODE', 'CLAUDE_PROJECT_DIR', 'PLUGIN_ROOT', 'PLUGIN_DATA', 'CLAUDE_PLUGIN_ROOT', 'AI_CENTER_BASE_URL', 'AI_CENTER_API_KEY']

const buildClaudeRegistration = (repo, server) => JSON.stringify({ projects: { [repo]: { mcpServers: { 'ai-center': server } } } })

// A throwaway home folder, holding a ~/.claude.json with this text when there is one.
function buildHome(root, claudeJson) {
	const home = join(root, 'home')
	mkdirSync(home)
	if (claudeJson !== undefined) writeFileSync(join(home, '.claude.json'), claudeJson)
	return home
}

// Runs `run` as the given client, with a throwaway home, then puts the real environment back.
function runAsClient(client, { codexHome, home }, run) {
	const originalEnv = { ...process.env }
	for (const name of CLIENT_ENV_NAMES) delete process.env[name]
	Object.assign(process.env, client, { CODEX_HOME: codexHome, HOME: home, USERPROFILE: home })
	try {
		return run()
	} finally {
		for (const key of Object.keys(process.env)) delete process.env[key]
		Object.assign(process.env, originalEnv)
	}
}

test('a missing project config file lets discovery continue to the global config', NEEDS_PYTHON, (t) => {
	const { repo, codexHome, globalConfig } = buildCodexRepo(buildTempRoot(t))
	writeFileSync(globalConfig, GLOBAL_TOML)

	runAsCodexHook(codexHome, () => assert.deepEqual(resolveIn(repo)(), GLOBAL_CONNECTION))
})

test('a project config without an ai-center entry lets discovery continue to the global config', NEEDS_PYTHON, (t) => {
	const { repo, codexHome, projectConfig, globalConfig } = buildCodexRepo(buildTempRoot(t))
	writeFileSync(projectConfig, '[model]\nname = "o3"\n')
	writeFileSync(globalConfig, GLOBAL_TOML)

	runAsCodexHook(codexHome, () => assert.deepEqual(resolveIn(repo)(), GLOBAL_CONNECTION))
})

test('with no ai-center entry anywhere the ordinary connection-not-found error is kept', NEEDS_PYTHON, (t) => {
	const { repo, codexHome, projectConfig } = buildCodexRepo(buildTempRoot(t))
	writeFileSync(projectConfig, '[model]\nname = "o3"\n')

	runAsCodexHook(codexHome, () => assert.throws(resolveIn(repo), (error) => {
		assert.match(error.message, /ai-center connection not found/)
		assert.doesNotMatch(error.message, /was not read|could not be read/)
		return true
	}))
})

test('invalid TOML in the project config stops discovery instead of using the global config', NEEDS_PYTHON, (t) => {
	const { repo, codexHome, projectConfig, globalConfig } = buildCodexRepo(buildTempRoot(t))
	writeFileSync(projectConfig, BROKEN_PROJECT_TOML)
	writeFileSync(globalConfig, GLOBAL_TOML)

	runAsCodexHook(codexHome, () => assertFailsWith(resolveIn(repo), /not valid TOML/, projectConfig))
})

test('an unreadable project config stops discovery instead of using the global config', (t) => {
	const { repo, codexHome, projectConfig, globalConfig } = buildCodexRepo(buildTempRoot(t))
	mkdirSync(projectConfig)
	writeFileSync(globalConfig, GLOBAL_TOML)

	runAsCodexHook(codexHome, () => assertFailsWith(resolveIn(repo), /could not be read \(EISDIR\)/, projectConfig))
})

test('an ai-center entry without a url stops discovery and names the field, not its value', NEEDS_PYTHON, (t) => {
	const { repo, codexHome, projectConfig, globalConfig } = buildCodexRepo(buildTempRoot(t))
	writeFileSync(projectConfig, `[mcp_servers.ai-center.http_headers]\nAuthorization = "Bearer ${PROJECT_SECRET}"\n`)
	writeFileSync(globalConfig, GLOBAL_TOML)

	runAsCodexHook(codexHome, () => assertFailsWith(resolveIn(repo), /needs a url/, projectConfig))
})

test('an ai-center entry whose key variable is not set stops discovery and names the field', NEEDS_PYTHON, (t) => {
	const { repo, codexHome, projectConfig, globalConfig } = buildCodexRepo(buildTempRoot(t))
	writeFileSync(projectConfig, '[mcp_servers.ai-center]\nurl = "http://project.invalid/mcp"\n' +
		'bearer_token_env_var = "AI_CENTER_TEST_KEY_NOT_SET"\n')
	writeFileSync(globalConfig, GLOBAL_TOML)

	runAsCodexHook(codexHome, () => assertFailsWith(resolveIn(repo), /needs bearer_token_env_var/, projectConfig))
})

test('a key held in the environment variable named by bearer_token_env_var still works', NEEDS_PYTHON, (t) => {
	const { repo, codexHome, projectConfig } = buildCodexRepo(buildTempRoot(t))
	writeFileSync(projectConfig, '[mcp_servers.ai-center]\nurl = "http://project.invalid/mcp"\n' +
		'bearer_token_env_var = "AI_CENTER_TEST_KEY"\n')

	runAsCodexHook(codexHome, () => {
		process.env.AI_CENTER_TEST_KEY = 'key-from-environment'
		assert.deepEqual(resolveIn(repo)(), { baseUrl: 'http://project.invalid', apiKey: 'key-from-environment' })
	})
})

test('a bearer_token_env_var that does not start with AI_CENTER_ throws and is never read', NEEDS_PYTHON, (t) => {
	const { repo, codexHome, projectConfig } = buildCodexRepo(buildTempRoot(t))
	writeFileSync(projectConfig, '[mcp_servers.ai-center]\nurl = "http://project.invalid/mcp"\n' +
		'bearer_token_env_var = "UNRELATED_TEST_SECRET"\n')

	runAsCodexHook(codexHome, () => {
		process.env.UNRELATED_TEST_SECRET = 'unrelated-secret-value'
		assert.throws(resolveIn(repo), (error) => {
			assert.match(error.message, /does not start with AI_CENTER_/)
			assert.ok(error.message.includes(projectConfig))
			assert.doesNotMatch(error.message, /unrelated-secret-value|UNRELATED_TEST_SECRET/)
			return true
		})
	})
})

test('a config.toml that starts with a UTF-8 byte order mark is read like any other', NEEDS_PYTHON, (t) => {
	const { repo, codexHome, projectConfig } = buildCodexRepo(buildTempRoot(t))
	writeFileSync(projectConfig, `﻿${GLOBAL_TOML}`)

	runAsCodexHook(codexHome, () => assert.deepEqual(resolveIn(repo)(), GLOBAL_CONNECTION))
})

test('a Codex client with a broken Codex config throws and never uses the Claude Code registration', NEEDS_PYTHON, (t) => {
	const root = buildTempRoot(t)
	const { repo, codexHome, projectConfig } = buildCodexRepo(root)
	writeFileSync(projectConfig, BROKEN_PROJECT_TOML)
	const home = buildHome(root, buildClaudeRegistration(repo, CLAUDE_SERVER))

	runAsClient(CODEX_CLIENT, { codexHome, home }, () => assertFailsWith(resolveIn(repo), /not valid TOML/, projectConfig))
})

test('a Claude Code client with an unreadable ~/.claude.json throws and names the file, never using the Codex config', NEEDS_PYTHON, (t) => {
	const root = buildTempRoot(t)
	const { repo, codexHome, projectConfig } = buildCodexRepo(root)
	writeFileSync(projectConfig, GLOBAL_TOML)
	const home = buildHome(root, '{ this is not json')

	runAsClient(CLAUDE_CLIENT, { codexHome, home }, () => {
		assertFailsWith(resolveIn(repo), /could not be read/, join(home, '.claude.json'))
	})
})

test('a Claude Code registration without an Authorization header throws and names the field, not its value', (t) => {
	const root = buildTempRoot(t)
	const { repo, codexHome } = buildCodexRepo(root)
	const home = buildHome(root, buildClaudeRegistration(repo, { url: CLAUDE_SERVER.url }))

	runAsClient(CLAUDE_CLIENT, { codexHome, home }, () => {
		assertFailsWith(resolveIn(repo), /needs a url and an Authorization header/, join(home, '.claude.json'))
	})
})

test('a Claude Code registration without a url throws and names the field, not the key', (t) => {
	const root = buildTempRoot(t)
	const { repo, codexHome } = buildCodexRepo(root)
	const home = buildHome(root, buildClaudeRegistration(repo, { headers: CLAUDE_SERVER.headers }))

	runAsClient(CLAUDE_CLIENT, { codexHome, home }, () => {
		assertFailsWith(resolveIn(repo), /needs a url and an Authorization header/, join(home, '.claude.json'))
	})
})

test('a Claude Code registration with a ${VAR} placeholder throws instead of sending the placeholder as the key', (t) => {
	const root = buildTempRoot(t)
	const { repo, codexHome } = buildCodexRepo(root)
	const server = { ...CLAUDE_SERVER, headers: { Authorization: 'Bearer ${AI_CENTER_TEST_KEY}' } }
	const home = buildHome(root, buildClaudeRegistration(repo, server))

	runAsClient(CLAUDE_CLIENT, { codexHome, home }, () => {
		assertFailsWith(resolveIn(repo), /placeholder/, join(home, '.claude.json'))
	})
})

test('a Claude Code client reads its own registration', (t) => {
	const root = buildTempRoot(t)
	const { repo, codexHome } = buildCodexRepo(root)
	const home = buildHome(root, buildClaudeRegistration(repo, CLAUDE_SERVER))

	runAsClient(CLAUDE_CLIENT, { codexHome, home }, () => assert.deepEqual(resolveIn(repo)(), CLAUDE_CONNECTION))
})

test('a Claude Code client with nothing registered gets the ordinary connection-not-found error', (t) => {
	const root = buildTempRoot(t)
	const { repo, codexHome } = buildCodexRepo(root)
	const home = buildHome(root)

	runAsClient(CLAUDE_CLIENT, { codexHome, home }, () => assertFailsWith(resolveIn(repo), /ai-center connection not found/))
})

test('an unknown client skips a broken Codex config, logs it, and uses the Claude Code registration', NEEDS_PYTHON, (t) => {
	const root = buildTempRoot(t)
	const { repo, codexHome, projectConfig } = buildCodexRepo(root)
	writeFileSync(projectConfig, BROKEN_PROJECT_TOML)
	const home = buildHome(root, buildClaudeRegistration(repo, CLAUDE_SERVER))
	const written = []
	t.mock.method(process.stderr, 'write', (text) => { written.push(String(text)); return true })

	runAsClient(UNKNOWN_CLIENT, { codexHome, home }, () => assert.deepEqual(resolveIn(repo)(), CLAUDE_CONNECTION))
	assert.equal(written.length, 1)
	assert.match(written[0], /not valid TOML/)
	assert.doesNotMatch(written[0], new RegExp(PROJECT_SECRET))
})

test('an unknown client with only a broken Codex config throws that problem, not the generic one', NEEDS_PYTHON, (t) => {
	const root = buildTempRoot(t)
	const { repo, codexHome, projectConfig } = buildCodexRepo(root)
	writeFileSync(projectConfig, BROKEN_PROJECT_TOML)
	const home = buildHome(root)
	t.mock.method(process.stderr, 'write', () => true)

	runAsClient(UNKNOWN_CLIENT, { codexHome, home }, () => assertFailsWith(resolveIn(repo), /not valid TOML/, projectConfig))
})

test('AI_CENTER_BASE_URL and AI_CENTER_API_KEY still win, even over a broken project config', (t) => {
	const { repo, codexHome, projectConfig } = buildCodexRepo(buildTempRoot(t))
	writeFileSync(projectConfig, BROKEN_PROJECT_TOML)

	runAsCodexHook(codexHome, () => {
		process.env.AI_CENTER_BASE_URL = 'http://env.invalid/'
		process.env.AI_CENTER_API_KEY = 'env-key'
		assert.deepEqual(resolveIn(repo)(), { baseUrl: 'http://env.invalid', apiKey: 'env-key' })
	})
})

// A real hook process with an empty PATH, started the way a hook starts: Node, then the module.
test('real process, no Python on PATH: the user is told Python is missing, not that the connection is', {
	skip: process.platform === 'win32' && 'an empty PATH does not hide the Windows py launcher',
}, (t) => {
	const root = buildTempRoot(t)
	const { repo, codexHome, projectConfig } = buildCodexRepo(root)
	const emptyBin = join(root, 'empty bin')
	mkdirSync(emptyBin)
	writeFileSync(projectConfig, '[mcp_servers.ai-center]\nurl = "http://project.invalid/mcp"\n' +
		`[mcp_servers.ai-center.http_headers]\nAuthorization = "Bearer ${PROJECT_SECRET}"\n`)
	const moduleUrl = new URL('../scripts/lib/connection/client-connections.mjs', import.meta.url).href
	const script = `import { resolveConnection } from ${JSON.stringify(moduleUrl)}\n` +
		`try { resolveConnection({ cwd: ${JSON.stringify(repo)}, projectDir: ${JSON.stringify(repo)} }) }\n` +
		'catch (error) { console.log(error.message) }'

	const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
		encoding: 'utf8',
		env: { PATH: emptyBin, HOME: root, PLUGIN_ROOT: CODEX_PLUGIN_ROOT, CODEX_HOME: codexHome },
	})

	assert.match(result.stdout, /Python was not found/)
	assert.doesNotMatch(result.stdout, /ai-center connection not found/)
	assert.doesNotMatch(result.stdout, new RegExp(PROJECT_SECRET))
})
