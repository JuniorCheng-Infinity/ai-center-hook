import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PLATFORM } from '../scripts/lib/connection/client-connections.mjs'
import { SUMMARY_RUN_ENV } from '../scripts/lib/hook-utils.mjs'
import { readInstalledPlugin } from '../scripts/lib/notice/update.mjs'
import { setupHookRun } from './fake-ai-center.mjs'

// The client a run pretends to be: Claude Code is told by CLAUDECODE, Codex by a plugin folder under .codex/.
const CLAUDE_CODE = { CLAUDECODE: '1' }
const CODEX = { CLAUDECODE: '', PLUGIN_ROOT: '/home/user/.codex/plugins/ai-assistant-mem' }
const UNKNOWN_CLIENT = { CLAUDECODE: '', PLUGIN_ROOT: '' }
// The name and version this repository's plugin says it has, so the tests never hardcode them.
const { name: PLUGIN_NAME, version: INSTALLED } = readInstalledPlugin(PLATFORM.claudeCode)
// A version certainly newer than the plugin's: a backend that has an update to offer.
const NEWER = '999.0.0'
// The key the fake backend is given, which must never appear in any output.
const KEY = 'test-key'
// Each way the fake backend can fail, with the HTTP status the hook should record (none when nothing answered).
const FAILURE_MODES = [
	['http-401', 401], ['bad-gateway', 502], ['server-error', 500], ['unreachable', null], ['timeout', null],
]

function hookTest(name, body) {
	test(name, async () => {
		const hook = setupHookRun()
		try {
			await body(hook)
		} finally {
			hook.cleanup()
		}
	})
}

const releaseWith = (latest) => JSON.stringify({ latest })
const formatExpected = () => `${PLUGIN_NAME} hooks update available: installed ${INSTALLED}, latest ${NEWER}.`
const startOf = (hook, session = 's1', source = 'startup') =>
	({ cwd: hook.dir, hook_event_name: 'SessionStart', session_id: session, source })
const runUpdate = (hook, { client = CLAUDE_CODE, latest = NEWER, mode = '', input = startOf(hook) } = {}) =>
	hook.runScript('notice.mjs', ['update'], input, mode, { ...client, FAKE_RELEASE: releaseWith(latest) })
const askedForRelease = (hook) => hook.sentRequests().filter((request) => request.method === 'GET')
// A run that certainly prints the notice, in a session of its own: proof that the setup would show one.
const assertControlShowsNotice = (hook) => {
	const control = runUpdate(hook, { input: startOf(hook, 'control') })
	assert.equal(JSON.parse(control.stdout).systemMessage, formatExpected())
}

hookTest('an outdated plugin gets one notice: stdout is one JSON object with only a systemMessage', (hook) => {
	const result = runUpdate(hook)
	assert.deepEqual(Object.keys(JSON.parse(result.stdout)), ['systemMessage'])
	assert.equal(JSON.parse(result.stdout).systemMessage, formatExpected())
})

hookTest('the Codex notice is the same one line', (hook) => {
	const result = runUpdate(hook, { client: CODEX })
	assert.equal(JSON.parse(result.stdout).systemMessage, formatExpected())
})

hookTest('a plugin that is up to date or newer than the latest prints nothing', (hook) => {
	assertControlShowsNotice(hook)
	assert.equal(runUpdate(hook, { latest: INSTALLED }).stdout, '')
	assert.equal(runUpdate(hook, { latest: '0.0.1', input: startOf(hook, 's2') }).stdout, '')
})

hookTest('a second run in a session prints nothing, and a new session or start source prints it again', (hook) => {
	assert.ok(runUpdate(hook).stdout)
	assert.equal(runUpdate(hook).stdout, '')
	assert.ok(runUpdate(hook, { input: startOf(hook, 's2') }).stdout)
	assert.ok(runUpdate(hook, { input: startOf(hook, 's1', 'resume') }).stdout)
})

hookTest('three runs at the same moment give one notice', async (hook) => {
	const input = JSON.stringify(startOf(hook))
	const runOnce = () => new Promise((resolve) => {
		const child = spawn(process.execPath, [join(hook.root, 'scripts', 'notice.mjs'), 'update'], {
			env: { ...hook.env, ...CLAUDE_CODE, FETCH_MODE: '', FAKE_RELEASE: releaseWith(NEWER) },
		})
		let stdout = ''
		child.stdout.on('data', (chunk) => {
			stdout += chunk
		})
		child.on('close', (status) => resolve({ stdout, status }))
		child.stdin.end(input)
	})
	const runs = await Promise.all([runOnce(), runOnce(), runOnce()])
	assert.deepEqual(runs.map((run) => run.status), [0, 0, 0])
	assert.equal(runs.filter((run) => run.stdout !== '').length, 1)
})

for (const [mode, status] of FAILURE_MODES) {
	hookTest(`a backend failing with ${mode} prints nothing and records the failure without the key`, (hook) => {
		assertControlShowsNotice(hook)
		const result = runUpdate(hook, { mode, input: startOf(hook, 's-fail') })
		assert.equal(result.stdout, '')
		const failure = hook.failures().at(-1)
		assert.equal(failure.hook, 'notice')
		assert.equal(failure.operation, 'release_latest')
		assert.equal(failure.endpoint, '/api/client/hooks/latest')
		assert.equal(failure.method, 'GET')
		assert.equal(failure.status_code, status)
		assert.equal(failure.request_id, askedForRelease(hook).at(-1).headers['x-request-id'])
		assert.ok(!JSON.stringify(hook.failures()).includes(KEY))
		assert.ok(!result.stderr.includes(KEY))
	})
}

hookTest('a release answer that is refused prints nothing and records the reason', (hook) => {
	assertControlShowsNotice(hook)
	const input = startOf(hook, 's-bad')
	const result = hook.runScript('notice.mjs', ['update'], input, '', { ...CLAUDE_CODE, FAKE_RELEASE: '{}' })
	assert.equal(result.stdout, '')
	assert.match(hook.failures().at(-1).info, /release answer refused: latest/)
})

hookTest('a client that is not listed still gets the notice', (hook) => {
	const result = runUpdate(hook, { client: UNKNOWN_CLIENT })
	assert.equal(JSON.parse(result.stdout).systemMessage, formatExpected())
	assert.equal(askedForRelease(hook).length, 1)
})

hookTest('a missing or unknown argument is reported and the session still starts', (hook) => {
	assertControlShowsNotice(hook)
	for (const args of [[], ['bogus'], ['toString']]) {
		assert.equal(hook.runScript('notice.mjs', args, startOf(hook, 's-arg'), '', CLAUDE_CODE).stdout, '')
	}
	const recorded = hook.failures().filter((failure) => failure.hook === 'notice')
	assert.equal(recorded.length, 3)
	for (const failure of recorded) assert.match(failure.info, /update/)
})

hookTest('a run started by the hooks own summarizer stays silent', (hook) => {
	assertControlShowsNotice(hook)
	const before = askedForRelease(hook).length
	const input = startOf(hook, 's-summary')
	const result = hook.runScript('notice.mjs', ['update'], input, '', { ...CLAUDE_CODE, [SUMMARY_RUN_ENV]: '1' })
	assert.equal(result.stdout, '')
	assert.equal(askedForRelease(hook).length, before)
})

hookTest('the notice leaves the recall output of the same session as it was', (hook) => {
	const profile = { static: [{ id: 's1', memory: 'Rule one here.' }], dynamic: [], buckets: { preferences: [] } }
	const env = { ...CLAUDE_CODE, FAKE_PROFILE: JSON.stringify(profile) }
	const recall = () => hook.runScript('context.mjs', ['rules'], startOf(hook), '', env)
	const alone = recall()
	const notice = runUpdate(hook)
	assert.equal(recall().stdout, alone.stdout)
	assert.ok(JSON.parse(alone.stdout).hookSpecificOutput.additionalContext.includes('Rule one here.'))
	assert.deepEqual(Object.keys(JSON.parse(notice.stdout)), ['systemMessage'])
})

test('SessionStart also runs the update notice, on every start source, with a short timeout', () => {
	const root = resolve('hooks-plugin')
	const config = JSON.parse(readFileSync(join(root, 'hooks/hooks.json'), 'utf8'))
	const groups = config.hooks.SessionStart.filter((group) =>
		group.hooks.some((hook) => hook.command.includes('/scripts/notice.mjs')))
	assert.equal(groups.length, 1)
	const [group] = groups
	assert.equal(group.matcher, 'startup|resume|compact|clear|fork')
	assert.equal(group.hooks.length, 1)
	assert.match(group.hooks[0].command, /\/scripts\/notice\.mjs" update$/)
	// Above the 2 seconds the check waits for the backend, and short enough that a first prompt is never held long.
	assert.ok(group.hooks[0].timeout > 2 && group.hooks[0].timeout <= 10)
	assert.ok(existsSync(join(root, 'scripts/notice.mjs')))
})
