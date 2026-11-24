import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PLATFORM, detectPlatform } from '../scripts/lib/connection/client-connections.mjs'

// These names are a contract with the backend, which maps them to its client types.
test('the platform names are the ones the backend recognizes', () => {
	assert.deepEqual(PLATFORM, { claudeCode: 'claude-code', codex: 'codex-mcp-client' })
})

test('detectPlatform answers with the platform constants', () => {
	const names = ['CLAUDECODE', 'PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT']
	const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]))
	try {
		for (const name of names) delete process.env[name]

		process.env.CLAUDECODE = '1'
		assert.equal(detectPlatform(), PLATFORM.claudeCode)

		delete process.env.CLAUDECODE
		process.env.PLUGIN_ROOT = '/home/user/.codex/plugins/cache/ai-assistant-mem/ai-assistant-mem/0.1.0'
		assert.equal(detectPlatform(), PLATFORM.codex)
	} finally {
		for (const name of names) {
			if (saved[name] === undefined) delete process.env[name]
			else process.env[name] = saved[name]
		}
	}
})

// The environment variables that decide the platform; each test sets exactly the ones it needs.
const PLATFORM_ENV_NAMES = ['CLAUDECODE', 'CLAUDE_PROJECT_DIR', 'PLUGIN_ROOT', 'PLUGIN_DATA', 'CLAUDE_PLUGIN_ROOT']

// Runs detectPlatform with exactly this environment, then puts the real environment back.
function detectWith(env) {
	const saved = Object.fromEntries(PLATFORM_ENV_NAMES.map((name) => [name, process.env[name]]))
	try {
		for (const name of PLATFORM_ENV_NAMES) delete process.env[name]
		Object.assign(process.env, env)
		return detectPlatform()
	} finally {
		for (const name of PLATFORM_ENV_NAMES) {
			if (saved[name] === undefined) delete process.env[name]
			else process.env[name] = saved[name]
		}
	}
}

const CUSTOM_HOME_ROOT = '/home/user/custom-codex-home/plugins/cache/ai-assistant-mem/ai-assistant-mem/0.1.0'
const CUSTOM_HOME_DATA = '/home/user/custom-codex-home/plugins/data/ai-assistant-mem'

test('a Codex hook under a custom Codex home is recognized by PLUGIN_ROOT and PLUGIN_DATA', () => {
	assert.equal(detectWith({ PLUGIN_ROOT: CUSTOM_HOME_ROOT, PLUGIN_DATA: CUSTOM_HOME_DATA }), PLATFORM.codex)
})

// Simulated: the Windows paths are only text, so this runs on any machine and proves nothing about a real Windows launch.
test('simulated Windows paths: a Codex hook with backslash paths is recognized', () => {
	const env = {
		PLUGIN_ROOT: 'C:\\Users\\user\\.codex\\plugins\\cache\\ai-assistant-mem\\ai-assistant-mem\\0.1.0',
		PLUGIN_DATA: 'C:\\Users\\user\\.codex\\plugins\\data\\ai-assistant-mem',
	}

	assert.equal(detectWith(env), PLATFORM.codex)
})

test('a default .codex/ hook with both variables is still Codex', () => {
	const env = {
		PLUGIN_ROOT: '/home/user/.codex/plugins/cache/ai-assistant-mem/ai-assistant-mem/0.1.0',
		PLUGIN_DATA: '/home/user/.codex/plugins/data/ai-assistant-mem',
	}

	assert.equal(detectWith(env), PLATFORM.codex)
})

// Simulated: the Windows path is only text, so this proves nothing about a real Windows launch.
test('simulated Windows paths: an older Codex hook with only a backslash .codex root is still Codex', () => {
	const env = { PLUGIN_ROOT: 'C:\\Users\\user\\.codex\\plugins\\cache\\ai-assistant-mem\\ai-assistant-mem\\0.1.0' }

	assert.equal(detectWith(env), PLATFORM.codex)
})

test('a Codex hook is still Codex when CLAUDE_PROJECT_DIR is set but CLAUDECODE is not', () => {
	const env = { CLAUDE_PROJECT_DIR: '/home/user/project', PLUGIN_ROOT: CUSTOM_HOME_ROOT, PLUGIN_DATA: CUSTOM_HOME_DATA }

	assert.equal(detectWith(env), PLATFORM.codex)
})

test('a root without .codex/ is not Codex unless PLUGIN_DATA is set too, and both must be nonempty', () => {
	assert.equal(detectWith({ PLUGIN_ROOT: CUSTOM_HOME_ROOT }), undefined)
	assert.equal(detectWith({ PLUGIN_ROOT: CUSTOM_HOME_ROOT, PLUGIN_DATA: '' }), undefined)
	assert.equal(detectWith({ PLUGIN_ROOT: '', PLUGIN_DATA: CUSTOM_HOME_DATA }), undefined)
})

test('a Codex hook started from a Claude Code shell is still Codex', () => {
	const env = { CLAUDECODE: '1', PLUGIN_ROOT: CUSTOM_HOME_ROOT, PLUGIN_DATA: CUSTOM_HOME_DATA }

	assert.equal(detectWith(env), PLATFORM.codex)
})

test('an older Codex hook with only a .codex/ root, started from a Claude Code shell, is still Codex', () => {
	const env = {
		CLAUDECODE: '1',
		PLUGIN_ROOT: '/home/user/.codex/plugins/cache/ai-assistant-mem/ai-assistant-mem/0.1.0',
	}

	assert.equal(detectWith(env), PLATFORM.codex)
})

test('a Claude Code hook started from a Codex shell is still Claude Code, even with leaked Codex variables', () => {
	const env = {
		CLAUDECODE: '1',
		CLAUDE_PROJECT_DIR: '/home/user/project',
		PLUGIN_ROOT: CUSTOM_HOME_ROOT,
		PLUGIN_DATA: CUSTOM_HOME_DATA,
	}

	assert.equal(detectWith(env), PLATFORM.claudeCode)
})

test('a real Claude Code hook environment is Claude Code', () => {
	const env = {
		CLAUDECODE: '1',
		CLAUDE_PROJECT_DIR: '/home/user/project',
		CLAUDE_PLUGIN_ROOT: '/home/user/.claude/plugins/cache/ai-assistant-mem',
	}

	assert.equal(detectWith(env), PLATFORM.claudeCode)
})

test('CLAUDE_PLUGIN_ROOT alone does not identify Claude Code or Codex', () => {
	assert.equal(detectWith({ CLAUDE_PLUGIN_ROOT: '/home/user/.claude/plugins/cache/ai-assistant-mem' }), undefined)
})
