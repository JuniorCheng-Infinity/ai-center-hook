import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveHookConnection } from '../scripts/lib/connection/client-connections.mjs'

const failuresUrl = new URL('../scripts/lib/connection/hook-failures.mjs', import.meta.url).href

test('resolveHookConnection finds the connection from the directory in the hook input', () => {
	const dir = mkdtempSync(join(tmpdir(), 'ai-center-helper-test-'))
	const names = ['AI_CENTER_BASE_URL', 'AI_CENTER_API_KEY', 'CLAUDE_PROJECT_DIR', 'CLAUDECODE', 'CLAUDE_PLUGIN_ROOT', 'PLUGIN_ROOT']
	const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]))
	try {
		for (const name of names) delete process.env[name]
		// A Codex plugin root makes this a Codex run, which reads the project's own .codex/config.toml.
		process.env.PLUGIN_ROOT = '/home/user/.codex/plugins/cache/ai-assistant-mem/ai-assistant-mem/0.1.0'
		mkdirSync(join(dir, '.codex'))
		writeFileSync(
			join(dir, '.codex', 'config.toml'),
			[
				'[mcp_servers.ai-center]',
				'url = "http://project.test/mcp"',
				'',
				'[mcp_servers.ai-center.http_headers]',
				'Authorization = "Bearer project-key"',
				'',
			].join('\n'),
		)
		assert.deepEqual(resolveHookConnection({ cwd: dir }), { baseUrl: 'http://project.test', apiKey: 'project-key' })
	} finally {
		for (const name of names) {
			if (saved[name] === undefined) delete process.env[name]
			else process.env[name] = saved[name]
		}
		rmSync(dir, { recursive: true, force: true })
	}
})

// Each case runs in its own process with its own HOME, so the failure log it writes is thrown away.
function runWith(work) {
	const home = mkdtempSync(join(tmpdir(), 'ai-center-helper-home-'))
	try {
		const code = `import { runAiCenterHook } from ${JSON.stringify(failuresUrl)}\nawait runAiCenterHook(${work})`
		return spawnSync(process.execPath, ['--input-type=module', '-e', code], {
			env: { ...process.env, HOME: home },
			input: '{}',
			encoding: 'utf8',
		})
	} finally {
		rmSync(home, { recursive: true, force: true })
	}
}

test('runAiCenterHook runs the work and exits 0 without a sound', () => {
	const result = runWith(`async () => { process.stdout.write('done') }`)
	assert.equal(result.status, 0)
	assert.equal(result.stdout, 'done')
	assert.equal(result.stderr, '')
})

test('runAiCenterHook reports an error from the work and still exits 0', () => {
	const result = runWith(`async () => { throw new Error('boom') }`)
	assert.equal(result.status, 0)
	assert.match(result.stderr, /ai-center hook error: boom/)
})
