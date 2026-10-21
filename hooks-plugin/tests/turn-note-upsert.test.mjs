import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FAKE_ERRORS, setupHookRun } from './fake-ai-center.mjs'

// One Stop event; Claude identifies the turn by prompt_id and Codex by turn_id.
const stopOf = (dir, turn, reply) => ({ cwd: dir, hook_event_name: 'Stop', ...turn, last_assistant_message: reply })
const claudeTurn = (id) => ({ prompt_id: id })
const codexTurn = (id) => ({ turn_id: id })
const namesOf = (calls) => calls.map((call) => call.name)

test('the first Stop of a turn adds the note and remembers its id', () => {
	const { dir, run, writeCalls, turnNoteIds, cleanup } = setupHookRun()
	try {
		run('turn-note.mjs', stopOf(dir, claudeTurn('turn-1'), 'First reply'))
		const calls = writeCalls()
		assert.deepEqual(namesOf(calls), ['memory_add'])
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
		assert.deepEqual(namesOf(calls), ['memory_add', 'memory_update'])
		assert.equal(calls[1].arguments.memory_id, calls[0].returned)
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
		assert.deepEqual(namesOf(calls), ['memory_add', 'memory_update', 'memory_update'])
		assert.equal(calls[2].arguments.memory_id, calls[1].returned)
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
		assert.deepEqual(namesOf(calls), ['memory_add', 'memory_add'])
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
		assert.deepEqual(namesOf(writeCalls()), ['memory_add', 'memory_update'])
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
		assert.deepEqual(namesOf(calls), ['memory_add', 'memory_update', 'memory_add'])
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
		rmSync(join(dir, '.cache', 'ai-center-hooks', 'turn-notes.json'))
		run('turn-note.mjs', stopOf(dir, claudeTurn('turn-1'), 'Second reply'))
		assert.deepEqual(namesOf(writeCalls()), ['memory_add', 'memory_add'])
	} finally {
		cleanup()
	}
})

test('without a turn id every Stop adds a note, as before', () => {
	const { dir, run, writeCalls, turnNoteIds, cleanup } = setupHookRun()
	try {
		run('turn-note.mjs', stopOf(dir, {}, 'First reply'))
		run('turn-note.mjs', stopOf(dir, {}, 'Second reply'))
		assert.deepEqual(namesOf(writeCalls()), ['memory_add', 'memory_add'])
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
		assert.deepEqual(namesOf(calls), ['memory_add', 'memory_update'])
		assert.equal(
			message(second),
			`ai-center memory: turn-note failed - memory_update HTTP 403, ${FAKE_ERRORS.noPermission}`,
		)
		assert.deepEqual(turnNoteIds(), { 'turn-1': calls[0].returned })
	} finally {
		cleanup()
	}
})
