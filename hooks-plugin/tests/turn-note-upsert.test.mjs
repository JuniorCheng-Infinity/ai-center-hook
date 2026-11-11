import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { FAKE_ERRORS, setupHookRun, writeFakeFetch } from './fake-ai-center.mjs'

// One Stop event; Claude identifies the turn by prompt_id and Codex by turn_id.
const stopOf = (dir, turn, reply) => ({ cwd: dir, hook_event_name: 'Stop', ...turn, last_assistant_message: reply })
const claudeTurn = (id) => ({ prompt_id: id })
const codexTurn = (id) => ({ turn_id: id })
const namesOf = (calls) => calls.map((call) => call.name)

for (const sameTurn of [true, false]) {
	test(`concurrent saves ${sameTurn ? 'add then update the same turn' : 'preserve both turn mappings'}`, async () => {
		const { dir, run, writeCalls, turnNoteIds, cleanup } = setupHookRun()
		try {
			run('context.mjs', { cwd: dir, hook_event_name: 'SessionStart' })
			const preload = writeFakeFetch(dir)
			// Keep the memory request open so the other hook reaches the cache during the first save.
			appendFileSync(preload, `
				const originalFetch = globalThis.fetch
				globalThis.fetch = async (url, options) => {
					if (JSON.parse(options.body).method === 'tools/call') {
						await new Promise(resolve => setTimeout(resolve, 300))
					}
					return originalFetch(url, options)
				}
			`)
			const jobs = ['turn-1', sameTurn ? 'turn-1' : 'turn-2'].map((id) => new Promise((resolve, reject) => {
				const child = spawn(process.execPath, [join(process.cwd(), 'hooks-plugin/scripts/turn-note.mjs')], {
					env: {
						...process.env, HOME: dir, NODE_OPTIONS: `--import=${preload}`,
						AI_CENTER_BASE_URL: 'http://test.invalid', AI_CENTER_API_KEY: 'test-key',
						TEST_CALLS: join(dir, 'calls.jsonl'), FETCH_MODE: '',
					},
					stdio: ['pipe', 'pipe', 'pipe'],
				})
				let stdout = ''
				let stderr = ''
				child.stdout.on('data', (chunk) => { stdout += chunk })
				child.stderr.on('data', (chunk) => { stderr += chunk })
				child.on('error', reject)
				child.on('close', (code) => resolve({ code, stdout, stderr }))
				child.stdin.end(JSON.stringify({ ...stopOf(dir, claudeTurn(id), id), session_id: 'test-session' }))
			}))
			const results = await Promise.allSettled(jobs)
			for (const result of results) {
				assert.equal(result.status, 'fulfilled')
				assert.deepEqual(result.value, { code: 0, stdout: '', stderr: '' })
			}
			const calls = writeCalls()
			assert.deepEqual(namesOf(calls), sameTurn ? ['document_add', 'document_update'] : ['document_add', 'document_add'])
			const ids = turnNoteIds()
			if (sameTurn) {
				assert.equal(calls[1].arguments.document_id, calls[0].returned)
				assert.deepEqual(ids, { 'turn-1': calls[1].returned })
			} else {
				assert.deepEqual(Object.keys(ids).sort(), ['turn-1', 'turn-2'])
				assert.deepEqual(Object.values(ids).sort(), calls.map((call) => call.returned).sort())
			}
		} finally { cleanup() }
	})
}

test('the first Stop of a turn adds the note and remembers its id', () => {
	const { dir, run, writeCalls, turnNoteIds, cleanup } = setupHookRun()
	try {
		run('turn-note.mjs', stopOf(dir, claudeTurn('turn-1'), 'First reply'))
		const calls = writeCalls()
		assert.deepEqual(namesOf(calls), ['document_add'])
		assert.deepEqual(turnNoteIds(), { 'turn-1': calls[0].returned })
	} finally {
		cleanup()
	}
})

test('a second Stop in the same turn updates that note with the latest text', () => {
	const { dir, run, writeCalls, turnNoteIds, cleanup } = setupHookRun()
	try {
		run('turn-note.mjs', stopOf(dir, claudeTurn('turn-1'), 'First reply'))
		run('turn-note.mjs', stopOf(dir, claudeTurn('turn-1'), 'Second reply'))
		const calls = writeCalls()
		assert.deepEqual(namesOf(calls), ['document_add', 'document_update'])
		assert.equal(calls[1].arguments.document_id, calls[0].returned)
		assert.match(calls[1].arguments.new_content, /Response: Second reply/)
		assert.deepEqual(turnNoteIds(), { 'turn-1': calls[1].returned })
	} finally {
		cleanup()
	}
})

test('every update uses the latest id, never a retired one', () => {
	const { dir, run, writeCalls, cleanup } = setupHookRun()
	try {
		for (const reply of ['First', 'Second', 'Third']) run('turn-note.mjs', stopOf(dir, claudeTurn('turn-1'), reply))
		const calls = writeCalls()
		assert.deepEqual(namesOf(calls), ['document_add', 'document_update', 'document_update'])
		assert.equal(calls[2].arguments.document_id, calls[1].returned)
	} finally {
		cleanup()
	}
})

test('a different turn adds its own note', () => {
	const { dir, run, writeCalls, turnNoteIds, cleanup } = setupHookRun()
	try {
		run('turn-note.mjs', stopOf(dir, claudeTurn('turn-1'), 'First turn'))
		run('turn-note.mjs', stopOf(dir, claudeTurn('turn-2'), 'Second turn'))
		const calls = writeCalls()
		assert.deepEqual(namesOf(calls), ['document_add', 'document_add'])
		assert.deepEqual(turnNoteIds(), { 'turn-1': calls[0].returned, 'turn-2': calls[1].returned })
	} finally {
		cleanup()
	}
})

test('a Codex turn is identified by its turn id', () => {
	const { dir, run, writeCalls, cleanup } = setupHookRun()
	try {
		run('turn-note.mjs', stopOf(dir, codexTurn('turn-1'), 'First reply'))
		run('turn-note.mjs', stopOf(dir, codexTurn('turn-1'), 'Second reply'))
		assert.deepEqual(namesOf(writeCalls()), ['document_add', 'document_update'])
	} finally {
		cleanup()
	}
})

test('a note that no longer exists is added again without reporting a failure', () => {
	const { dir, run, message, failures, writeCalls, turnNoteIds, cleanup } = setupHookRun()
	try {
		run('turn-note.mjs', stopOf(dir, claudeTurn('turn-1'), 'First reply'))
		const second = run('turn-note.mjs', stopOf(dir, claudeTurn('turn-1'), 'Second reply'), 'update-not-found')
		const calls = writeCalls()
		assert.deepEqual(namesOf(calls), ['document_add', 'document_update', 'document_add'])
		assert.equal(message(second), undefined)
		assert.deepEqual(failures(), [])
		assert.deepEqual(turnNoteIds(), { 'turn-1': calls[2].returned })
	} finally {
		cleanup()
	}
})

test('a lost record of the turn adds a new note', () => {
	const { dir, run, writeCalls, cleanup } = setupHookRun()
	try {
		run('turn-note.mjs', stopOf(dir, claudeTurn('turn-1'), 'First reply'))
		const cacheDir = join(dir, '.cache', 'ai-center-hooks')
		const file = readdirSync(cacheDir).find((name) => name.startsWith('turn-notes-'))
		rmSync(join(cacheDir, file))
		run('turn-note.mjs', stopOf(dir, claudeTurn('turn-1'), 'Second reply'))
		assert.deepEqual(namesOf(writeCalls()), ['document_add', 'document_add'])
	} finally {
		cleanup()
	}
})

test('without a turn id every Stop adds a note, as before', () => {
	const { dir, run, writeCalls, turnNoteIds, cleanup } = setupHookRun()
	try {
		run('turn-note.mjs', stopOf(dir, {}, 'First reply'))
		run('turn-note.mjs', stopOf(dir, {}, 'Second reply'))
		assert.deepEqual(namesOf(writeCalls()), ['document_add', 'document_add'])
		assert.equal(turnNoteIds(), undefined)
	} finally {
		cleanup()
	}
})

test('a programmatic run adds no note', () => {
	const { dir, run, writeCalls, turnNoteIds, cleanup } = setupHookRun()
	try {
		const transcript = join(dir, 'transcript.jsonl')
		const prompt = {
			type: 'user',
			promptId: 'turn-1',
			entrypoint: 'sdk-cli',
			message: { role: 'user', content: 'summarize this' },
		}
		writeFileSync(transcript, JSON.stringify(prompt))
		run('turn-note.mjs', { ...stopOf(dir, claudeTurn('turn-1'), 'A summary'), transcript_path: transcript })
		assert.deepEqual(writeCalls(), [])
		assert.equal(turnNoteIds(), undefined)
	} finally {
		cleanup()
	}
})

test('any other update failure is reported and does not add a duplicate', () => {
	const { dir, run, message, writeCalls, turnNoteIds, cleanup } = setupHookRun()
	try {
		run('turn-note.mjs', stopOf(dir, claudeTurn('turn-1'), 'First reply'))
		const second = run('turn-note.mjs', stopOf(dir, claudeTurn('turn-1'), 'Second reply'), 'tool-error')
		const calls = writeCalls()
		assert.deepEqual(namesOf(calls), ['document_add', 'document_update'])
		assert.equal(
			message(second),
			`ai-center memory: turn-note failed - document_update HTTP 403, ${FAKE_ERRORS.noPermission}`,
		)
		assert.deepEqual(turnNoteIds(), { 'turn-1': calls[0].returned })
	} finally {
		cleanup()
	}
})

const decisionStopOf = (dir, turnId, reply, session = 'test-session') => ({
	cwd: dir, hook_event_name: 'Stop', prompt_id: turnId,
	last_assistant_message: reply, session_id: session,
})
const lookupOf = (request) => request.params._meta?.['ai-center/lookup']
const requestsOf = (requests, name) => requests.filter((r) => r.method === 'tools/call' && r.params.name === name)
const requestIdOf = (request) => request.headers['x-request-id']
const hitsOf = (...hits) => ({ FAKE_SEARCH_RESULTS: JSON.stringify(hits) })
// A hit as v5 gives it: a fact Supermemory made, and the document it came from.
const earlierNote = (id, similarity = 0.9, documentId = `doc-${id}`) => ({
	id,
	memory: 'The earlier work is done.',
	similarity,
	included: { document: { id: documentId, title: 'User prompt: earlier work\n\nResponse: done' } },
})

test('the first Stop of a turn searches the project\'s notes before it saves anything', () => {
	const { dir, run, toolCalls, cleanup } = setupHookRun()
	try {
		run('turn-note.mjs', decisionStopOf(dir, 'turn-1', 'Fixed the login bug.'))
		const calls = toolCalls()
		assert.deepEqual(namesOf(calls), ['memory_search', 'document_add'])
		assert.deepEqual(calls[0].arguments, { project_id: 42, query: 'Fixed the login bug.' })
	} finally { cleanup() }
})

test('nothing found: the note is added, and the add says why and which search it came from', () => {
	const { dir, run, sentRequests, cleanup } = setupHookRun()
	try {
		run('turn-note.mjs', decisionStopOf(dir, 'turn-1', 'First reply'))
		const [search] = requestsOf(sentRequests(), 'memory_search')
		const [add] = requestsOf(sentRequests(), 'document_add')
		assert.deepEqual(lookupOf(add), {
			searchRequestId: requestIdOf(search), decision: 'add', reason: 'no earlier turn note found', selectedId: null,
		})
		assert.equal(add.params.arguments.lookup, undefined)
	} finally { cleanup() }
})

test('a later turn about the same setting updates the earlier note, even from another session', () => {
	const { dir, run, writeCalls, sentRequests, cleanup } = setupHookRun()
	try {
		run('turn-note.mjs', decisionStopOf(dir, 'turn-1', 'sessionend.hooks.timeout is now 5 sec.', 'session-1'))
		const first = writeCalls()[0]
		const later = decisionStopOf(dir, 'turn-2', 'sessionend.hooks.timeout is now 10 sec.', 'session-2')
		run('turn-note.mjs', later, '', hitsOf(earlierNote('memory-1', 0.92, first.returned)))
		const calls = writeCalls()
		assert.deepEqual(namesOf(calls), ['document_add', 'document_update'])
		assert.equal(calls[1].arguments.document_id, first.returned)
		assert.match(calls[1].arguments.new_content, /10 sec/)
		const [, search] = requestsOf(sentRequests(), 'memory_search')
		const [update] = requestsOf(sentRequests(), 'document_update')
		assert.deepEqual(lookupOf(update), {
			searchRequestId: requestIdOf(search),
			decision: 'update',
			reason: 'most similar earlier turn note',
			selectedId: 'memory-1',
		})
	} finally { cleanup() }
})

test('a chunk of an earlier note updates the document it came from', () => {
	const { dir, run, writeCalls, sentRequests, cleanup } = setupHookRun()
	try {
		run('turn-note.mjs', decisionStopOf(dir, 'turn-1', 'The cache ttl is now 5 min.', 'session-1'))
		const first = writeCalls()[0]
		const chunk = {
			id: 'chunk-1',
			chunk: 'User prompt: earlier work',
			similarity: 0.88,
			included: { document: { id: first.returned, title: 'User prompt: earlier work\n\nResponse: done' } },
		}
		run('turn-note.mjs', decisionStopOf(dir, 'turn-2', 'The cache ttl is now 10 min.', 'session-2'), '', hitsOf(chunk))
		const calls = writeCalls()
		assert.deepEqual(namesOf(calls), ['document_add', 'document_update'])
		assert.equal(calls[1].arguments.document_id, first.returned)
		const lookup = lookupOf(requestsOf(sentRequests(), 'document_update')[0])
		assert.equal(lookup.decision, 'update')
		assert.equal(lookup.selectedId, 'chunk-1')
	} finally { cleanup() }
})

test('hits that name no source document add the note and say why', () => {
	const { dir, run, writeCalls, sentRequests, cleanup } = setupHookRun()
	try {
		const bare = { id: 'memory-1', memory: 'User prompt: earlier work', similarity: 0.95, included: null }
		run('turn-note.mjs', decisionStopOf(dir, 'turn-1', 'A reply'), '', hitsOf(bare))
		assert.deepEqual(namesOf(writeCalls()), ['document_add'])
		const lookup = lookupOf(requestsOf(sentRequests(), 'document_add')[0])
		assert.equal(lookup.decision, 'add')
		assert.equal(lookup.selectedId, null)
		assert.match(lookup.reason, /search\.include\.documents/)
	} finally { cleanup() }
})

test('a hit from a document that is not a turn note is never updated', () => {
	const { dir, run, writeCalls, sentRequests, cleanup } = setupHookRun()
	try {
		const fact = { id: 'memory-2', memory: 'A fact', similarity: 0.99, included: { document: { id: 'doc-x', title: 'DECISION: use MySQL' } } }
		run('turn-note.mjs', decisionStopOf(dir, 'turn-1', 'A reply'), '', hitsOf(fact))
		assert.deepEqual(namesOf(writeCalls()), ['document_add'])
		assert.equal(lookupOf(requestsOf(sentRequests(), 'document_add')[0]).reason, 'no earlier turn note found')
	} finally { cleanup() }
})

test('a repeat Stop updates only its known note, without searching again, and records the decision', () => {
	const { dir, run, toolCalls, sentRequests, cleanup } = setupHookRun()
	try {
		run('turn-note.mjs', decisionStopOf(dir, 'turn-1', 'First reply'))
		run('turn-note.mjs', decisionStopOf(dir, 'turn-1', 'Second reply'))
		const calls = toolCalls()
		assert.deepEqual(namesOf(calls), ['memory_search', 'document_add', 'document_update'])
		const [update] = requestsOf(sentRequests(), 'document_update')
		assert.deepEqual(lookupOf(update), {
			searchRequestId: null, decision: 'update', reason: 'same turn', selectedId: calls[1].returned,
		})
		assert.equal(update.params.arguments.lookup, undefined)
	} finally { cleanup() }
})

test('a failed search still saves the note, and records the failure instead of reporting one', () => {
	const { dir, run, message, failures, sentRequests, writeCalls, cleanup } = setupHookRun()
	try {
		const result = run('turn-note.mjs', decisionStopOf(dir, 'turn-1', 'First reply'), 'search-error')
		assert.deepEqual(namesOf(writeCalls()), ['document_add'])
		assert.equal(message(result), undefined)
		assert.deepEqual(failures(), [])
		const [search] = requestsOf(sentRequests(), 'memory_search')
		const lookup = lookupOf(requestsOf(sentRequests(), 'document_add')[0])
		assert.equal(lookup.decision, 'add')
		assert.equal(lookup.selectedId, null)
		assert.equal(lookup.searchRequestId, requestIdOf(search))
		assert.match(lookup.reason, /^search failed: /)
	} finally { cleanup() }
})

test('a chosen note that no longer exists is added instead, without reporting a failure', () => {
	const { dir, run, message, failures, sentRequests, writeCalls, cleanup } = setupHookRun()
	try {
		const stop = decisionStopOf(dir, 'turn-1', 'Second reply')
		const result = run('turn-note.mjs', stop, 'update-not-found', hitsOf(earlierNote('note-1')))
		assert.deepEqual(namesOf(writeCalls()), ['document_update', 'document_add'])
		assert.equal(message(result), undefined)
		assert.deepEqual(failures(), [])
		const lookup = lookupOf(requestsOf(sentRequests(), 'document_add')[0])
		assert.equal(lookup.decision, 'add')
		assert.equal(lookup.selectedId, 'note-1')
		assert.match(lookup.reason, /no longer exists/)
	} finally { cleanup() }
})

test('the same turn id in different sessions creates separate notes', () => {
	const { dir, run, writeCalls, cleanup } = setupHookRun()
	try {
		run('turn-note.mjs', decisionStopOf(dir, 'turn-1', 'Session one', 'session-1'))
		run('turn-note.mjs', decisionStopOf(dir, 'turn-1', 'Session two', 'session-2'))
		run('turn-note.mjs', decisionStopOf(dir, 'turn-1', 'Session one revised', 'session-1'))
		const calls = writeCalls()
		assert.deepEqual(namesOf(calls), ['document_add', 'document_add', 'document_update'])
		assert.equal(calls[2].arguments.document_id, calls[0].returned)
	} finally { cleanup() }
})

test('the same session and turn on another connection cannot replace the first note', () => {
	const { dir, run, writeCalls, cleanup } = setupHookRun()
	try {
		run('turn-note.mjs', decisionStopOf(dir, 'turn-1', 'First connection'))
		run('turn-note.mjs', decisionStopOf(dir, 'turn-1', 'Second connection'), '', { AI_CENTER_API_KEY: 'another-key' })
		assert.deepEqual(namesOf(writeCalls()), ['document_add', 'document_add'])
	} finally { cleanup() }
})

test('legacy unscoped mappings cannot cause an update', () => {
	const { dir, run, writeCalls, cleanup } = setupHookRun()
	try {
		const cache = join(dir, '.cache', 'ai-center-hooks')
		mkdirSync(cache, { recursive: true })
		writeFileSync(join(cache, 'turn-notes.json'), JSON.stringify({ 'turn-1': 'unrelated-note' }))
		run('turn-note.mjs', decisionStopOf(dir, 'turn-1', 'New reply'))
		assert.deepEqual(namesOf(writeCalls()), ['document_add'])
	} finally { cleanup() }
})

test('without session identity or transcript, repeated ids add unless the search finds the earlier note', () => {
	const { dir, run, writeCalls, cleanup } = setupHookRun()
	try {
		for (const reply of ['First', 'Second']) {
			run('turn-note.mjs', decisionStopOf(dir, 'turn-1', reply, null))
		}
		assert.deepEqual(namesOf(writeCalls()), ['document_add', 'document_add'])
	} finally { cleanup() }
})
