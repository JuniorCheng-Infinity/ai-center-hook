import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SUMMARY_RUN_ENV } from '../scripts/lib/hook-utils.mjs'
import { setupHookRun } from './fake-ai-center.mjs'

test('a hook that runs inside our own summarizer run does nothing', () => {
	const { dir, run, sentRequests, cleanup } = setupHookRun()
	try {
		const guard = { [SUMMARY_RUN_ENV]: '1' }
		run('context.mjs', { cwd: dir, hook_event_name: 'SessionStart', source: 'startup' }, '', guard)
		run('turn-note.mjs', { cwd: dir, hook_event_name: 'Stop', prompt_id: 'turn-1', last_assistant_message: 'x' }, '', guard)
		assert.deepEqual(sentRequests(), [])
	} finally {
		cleanup()
	}
})
