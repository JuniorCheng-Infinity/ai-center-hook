import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setupHookRun } from './fake-ai-center.mjs'

const LOOKUP_KEY = 'ai-center/lookup'

// One Stop event without a transcript, so the note is just the reply.
const stopOf = (dir, turnId, reply) => ({
	cwd: dir,
	hook_event_name: 'Stop',
	prompt_id: turnId,
	last_assistant_message: reply,
})
const namesOf = (calls) => calls.map((call) => call.name)

// The notes this hook wrote in earlier turns, as its own record of them (turn id -> latest note id).
function seedOwnNotes(dir, notes) {
	const cache = join(dir, '.cache', 'ai-center-hooks')
	mkdirSync(cache, { recursive: true })
	writeFileSync(join(cache, 'turn-notes.json'), JSON.stringify(notes))
}

const hitsOf = (...hits) => ({ FAKE_SEARCH_RESULTS: JSON.stringify(hits) })
const earlierNote = (id, similarity = 0.9) => ({
	id,
	memory: 'User prompt: earlier work\n\nResponse: done',
	similarity,
})

const requestsOf = (requests, name) => requests.filter((r) => r.method === 'tools/call' && r.params.name === name)
const lookupOf = (request) => request.params._meta?.[LOOKUP_KEY]
const requestIdOf = (request) => request.headers['x-request-id']

test('the first Stop of a turn searches with the reply before it saves anything', () => {
	const { dir, run, toolCalls, cleanup } = setupHookRun()
	try {
		run('turn-note.mjs', stopOf(dir, 'turn-1', 'Fixed the login bug.'))
		const calls = toolCalls()
		assert.deepEqual(namesOf(calls), ['memory_search', 'memory_add'])
		assert.deepEqual(calls[0].arguments, { project_id: 42, query: 'Fixed the login bug.' })
	} finally {
		cleanup()
	}
})

test('the search text is the prompt and the reply, without the thinking', () => {
	const { dir, run, toolCalls, cleanup } = setupHookRun()
	try {
		const transcript = join(dir, 'transcript.jsonl')
		const entries = [
			{ type: 'user', promptId: 'turn-1', message: { role: 'user', content: 'fix the login bug' } },
			{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret plan' }] } },
		]
		writeFileSync(transcript, entries.map((entry) => JSON.stringify(entry)).join('\n'))
		run('turn-note.mjs', { ...stopOf(dir, 'turn-1', 'Fixed.'), transcript_path: transcript }, '', { CLAUDECODE: '1' })
		assert.equal(toolCalls()[0].arguments.query, 'fix the login bug\n\nFixed.')
	} finally {
		cleanup()
	}
})

test('nothing found: the note is added, and the add says why and which search it came from', () => {
	const { dir, run, sentRequests, cleanup } = setupHookRun()
	try {
		run('turn-note.mjs', stopOf(dir, 'turn-1', 'First reply'))
		const [search] = requestsOf(sentRequests(), 'memory_search')
		const [add] = requestsOf(sentRequests(), 'memory_add')
		assert.deepEqual(lookupOf(add), {
			searchRequestId: requestIdOf(search),
			decision: 'add',
			reason: 'no earlier turn note found',
			selectedId: null,
		})
		assert.equal(add.params.arguments.lookup, undefined)
	} finally {
		cleanup()
	}
})

test('an earlier turn note of its own is updated with the new note instead of adding another', () => {
	const { dir, run, toolCalls, sentRequests, turnNoteIds, cleanup } = setupHookRun()
	try {
		seedOwnNotes(dir, { 'turn-0': 'note-1' })
		run('turn-note.mjs', stopOf(dir, 'turn-1', 'Second reply'), '', hitsOf(earlierNote('note-1')))
		const calls = toolCalls()
		assert.deepEqual(namesOf(calls), ['memory_search', 'memory_update'])
		assert.equal(calls[1].arguments.memory_id, 'note-1')
		assert.equal(calls[1].arguments.new_content, 'Response: Second reply')
		const [search] = requestsOf(sentRequests(), 'memory_search')
		const [update] = requestsOf(sentRequests(), 'memory_update')
		assert.deepEqual(lookupOf(update), {
			searchRequestId: requestIdOf(search),
			decision: 'update',
			reason: 'most similar earlier turn note',
			selectedId: 'note-1',
		})
		assert.equal(turnNoteIds()['turn-1'], calls[1].returned)
	} finally {
		cleanup()
	}
})

test('a similar turn note the hook did not write is never replaced', () => {
	const { dir, run, toolCalls, cleanup } = setupHookRun()
	try {
		seedOwnNotes(dir, { 'turn-0': 'note-1' })
		run('turn-note.mjs', stopOf(dir, 'turn-1', 'Second reply'), '', hitsOf(earlierNote('someone-elses', 0.99)))
		assert.deepEqual(namesOf(toolCalls()), ['memory_search', 'memory_add'])
	} finally {
		cleanup()
	}
})

test('a repeat Stop in the same turn updates its own note without searching again', () => {
	const { dir, run, toolCalls, sentRequests, cleanup } = setupHookRun()
	try {
		run('turn-note.mjs', stopOf(dir, 'turn-1', 'First reply'))
		run('turn-note.mjs', stopOf(dir, 'turn-1', 'Second reply'))
		const calls = toolCalls()
		assert.deepEqual(namesOf(calls), ['memory_search', 'memory_add', 'memory_update'])
		const [update] = requestsOf(sentRequests(), 'memory_update')
		assert.deepEqual(lookupOf(update), {
			searchRequestId: null,
			decision: 'update',
			reason: 'same turn',
			selectedId: calls[1].returned,
		})
	} finally {
		cleanup()
	}
})

test('a failed search still saves the note, and records the failure instead of reporting one', () => {
	const { dir, run, message, failures, sentRequests, toolCalls, cleanup } = setupHookRun()
	try {
		const result = run('turn-note.mjs', stopOf(dir, 'turn-1', 'First reply'), 'search-error')
		assert.deepEqual(namesOf(toolCalls()), ['memory_search', 'memory_add'])
		assert.equal(message(result), undefined)
		assert.deepEqual(failures(), [])
		const [search] = requestsOf(sentRequests(), 'memory_search')
		const lookup = lookupOf(requestsOf(sentRequests(), 'memory_add')[0])
		assert.equal(lookup.decision, 'add')
		assert.equal(lookup.selectedId, null)
		assert.equal(lookup.searchRequestId, requestIdOf(search))
		assert.match(lookup.reason, /^search failed: /)
	} finally {
		cleanup()
	}
})

test('a chosen note that no longer exists is added instead, without reporting a failure', () => {
	const { dir, run, message, failures, sentRequests, toolCalls, cleanup } = setupHookRun()
	try {
		seedOwnNotes(dir, { 'turn-0': 'note-1' })
		const stop = stopOf(dir, 'turn-1', 'Second reply')
		const result = run('turn-note.mjs', stop, 'update-not-found', hitsOf(earlierNote('note-1')))
		assert.deepEqual(namesOf(toolCalls()), ['memory_search', 'memory_update', 'memory_add'])
		assert.equal(message(result), undefined)
		assert.deepEqual(failures(), [])
		const lookup = lookupOf(requestsOf(sentRequests(), 'memory_add')[0])
		assert.equal(lookup.decision, 'add')
		assert.equal(lookup.selectedId, 'note-1')
		assert.match(lookup.reason, /no longer exists/)
	} finally {
		cleanup()
	}
})
