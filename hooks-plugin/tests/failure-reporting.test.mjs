import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { FAKE_ERRORS, setupHookRun } from './fake-ai-center.mjs'

const stopInput = (dir) => ({ cwd: dir, hook_event_name: 'Stop', last_assistant_message: 'Done' })
const toolUse = (dir) =>
	({ cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {}, tool_response: 'x' })

test('a failed tool call is shown with its status code and info, and recorded', () => {
	const { dir, run, message, failures, sentRequests, cleanup } = setupHookRun()
	try {
		const result = run('turn-note.mjs', stopInput(dir), 'tool-error')
		assert.equal(
			message(result),
			`ai-center memory: turn-note failed - memory_add HTTP 403, ${FAKE_ERRORS.noPermission}`,
		)
		const [failure] = failures()
		assert.equal(failure.hook, 'turn-note')
		assert.equal(failure.operation, 'memory_add')
		assert.equal(failure.endpoint, '/api/client/mcp')
		assert.equal(failure.method, 'POST')
		assert.equal(failure.status_code, 403)
		assert.equal(failure.info, FAKE_ERRORS.noPermission)
		assert.equal(failure.display, 'now')
		assert.ok(failure.created_datetime)
		assert.ok(Number.isInteger(failure.latency_ms))
		// The same id goes to the server, so a local line can be matched to its request_log_tbl row.
		const memoryAdd = sentRequests().find((request) => request.params?.name === 'memory_add')
		assert.equal(memoryAdd.headers['x-request-id'], failure.request_id)
	} finally {
		cleanup()
	}
})

test('a rejected request shows its HTTP status and the reason', () => {
	const { dir, run, message, failures, cleanup } = setupHookRun()
	try {
		const result = run('turn-note.mjs', stopInput(dir), 'http-401')
		assert.equal(message(result), 'ai-center memory: turn-note failed - initialize HTTP 401, unauthorized')
		assert.equal(failures()[0].status_code, 401)
	} finally {
		cleanup()
	}
})

test('a reply in the wrong format is shown as invalid format', () => {
	const { dir, run, message, cleanup } = setupHookRun()
	try {
		const result = run('turn-note.mjs', stopInput(dir), 'bad-gateway')
		assert.equal(message(result), 'ai-center memory: turn-note failed - initialize HTTP 502, invalid format')
	} finally {
		cleanup()
	}
})

test('a protocol error is shown with its own message', () => {
	const { dir, run, message, cleanup } = setupHookRun()
	try {
		const result = run('turn-note.mjs', stopInput(dir), 'rpc-error')
		assert.equal(message(result), 'ai-center memory: turn-note failed - initialize HTTP 200, Invalid request')
	} finally {
		cleanup()
	}
})

test('a data line that is not JSON is shown as invalid format', () => {
	const { dir, run, message, cleanup } = setupHookRun()
	try {
		const result = run('turn-note.mjs', stopInput(dir), 'bad-data-line')
		assert.equal(message(result), 'ai-center memory: turn-note failed - initialize HTTP 200, invalid format')
	} finally {
		cleanup()
	}
})

test('a long message is shown in full', () => {
	const { dir, run, message, cleanup } = setupHookRun()
	try {
		const result = run('turn-note.mjs', stopInput(dir), 'server-error')
		assert.equal(
			message(result),
			`ai-center memory: turn-note failed - memory_add HTTP 500, ${FAKE_ERRORS.unexpected}`,
		)
	} finally {
		cleanup()
	}
})

test('an unreachable server and a timeout are shown without a status code', () => {
	const { dir, run, message, failures, cleanup } = setupHookRun()
	try {
		assert.equal(message(run('turn-note.mjs', stopInput(dir), 'unreachable')),
			'ai-center memory: turn-note failed - initialize unreachable (ECONNREFUSED)')
		assert.equal(message(run('turn-note.mjs', stopInput(dir), 'timeout')),
			'ai-center memory: turn-note failed - initialize timeout after 8s')
		assert.deepEqual(failures().map((failure) => failure.status_code), [null, null])
	} finally {
		cleanup()
	}
})

test('an error that is not an ai-center call is shown too', () => {
	const { dir, run, message, cleanup } = setupHookRun()
	try {
		const input = { ...stopInput(dir), transcript_path: join(dir, 'missing.jsonl') }
		assert.match(message(run('turn-note.mjs', input)), /^ai-center memory: turn-note failed - .*ENOENT/)
	} finally {
		cleanup()
	}
})

test('the same failure is shown once a minute', () => {
	const { dir, run, message, failures, cleanup } = setupHookRun()
	try {
		assert.ok(message(run('turn-note.mjs', stopInput(dir), 'tool-error')))
		assert.equal(message(run('turn-note.mjs', stopInput(dir), 'tool-error')), undefined)
		assert.deepEqual(failures().map((failure) => failure.display), ['now', 'suppressed'])
	} finally {
		cleanup()
	}
})

test('failures of background and session-start hooks are recorded but not shown at once', () => {
	const { dir, run, message, failures, cleanup } = setupHookRun()
	try {
		const background = run('tool-observer.mjs', toolUse(dir), 'tool-error')
		const sessionStart = run('context.mjs', { cwd: dir, hook_event_name: 'SessionStart' }, 'unreachable')
		assert.equal(message(background), undefined)
		assert.equal(message(sessionStart), undefined)
		assert.deepEqual(
			failures().map((failure) => [failure.hook, failure.display]),
			[['tool-observer', 'pending'], ['context', 'pending']],
		)
	} finally {
		cleanup()
	}
})

test('the next prompt shows one summary of the pending failures, once', () => {
	const { dir, run, message, cleanup } = setupHookRun()
	try {
		run('tool-observer.mjs', toolUse(dir), 'tool-error')
		run('context.mjs', { cwd: dir, hook_event_name: 'SessionStart' }, 'unreachable')
		const prompt = { cwd: dir, hook_event_name: 'UserPromptSubmit', prompt: 'next question' }
		assert.equal(
			message(run('failure-summary.mjs', prompt)),
			'ai-center memory: 2 hook failures since your last prompt (tool-observer x1, context x1), ' +
				'last: initialize unreachable (ECONNREFUSED)',
		)
		assert.equal(message(run('failure-summary.mjs', prompt)), undefined)
	} finally {
		cleanup()
	}
})

test('the summary stays silent when nothing failed', () => {
	const { dir, run, message, cleanup } = setupHookRun()
	try {
		const prompt = { cwd: dir, hook_event_name: 'UserPromptSubmit', prompt: 'hello there' }
		assert.equal(message(run('failure-summary.mjs', prompt)), undefined)
	} finally {
		cleanup()
	}
})
