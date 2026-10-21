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
