import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LOOKUP_QUERY_MAX_CHARS, chooseNoteToUpdate, lookupQuery } from '../scripts/lib/note/note-lookup.mjs'
import { memoryAddTurn } from '../scripts/lib/note/memory-handler.mjs'

const turnNote = (id, similarity, prompt = 'fix the login bug') => ({
	id,
	memory: `User prompt: ${prompt}\n\nResponse: done`,
	similarity,
})

// The ids of the notes this hook wrote itself; only these may be replaced.
const own = (...ids) => new Set(ids)

test('lookupQuery joins the prompt and the response, without the thinking', () => {
	assert.equal(lookupQuery({ prompt: 'fix the login bug', response: 'Fixed.' }), 'fix the login bug\n\nFixed.')
})

test('lookupQuery uses the one that exists when the other is empty', () => {
	assert.equal(lookupQuery({ prompt: 'fix it', response: '' }), 'fix it')
	assert.equal(lookupQuery({ prompt: '', response: 'Done.' }), 'Done.')
	assert.equal(lookupQuery({}), '')
	assert.equal(lookupQuery(), '')
})

test('lookupQuery drops the blank lines a list of prompts starts with', () => {
	assert.equal(lookupQuery({ prompt: '\n1. first\n2. second', response: 'ok' }), '1. first\n2. second\n\nok')
})

test('lookupQuery is cut at the limit, and a short text is left alone', () => {
	const cut = lookupQuery({ prompt: 'a'.repeat(LOOKUP_QUERY_MAX_CHARS), response: 'b'.repeat(50) })
	assert.equal(cut.length, LOOKUP_QUERY_MAX_CHARS)
	assert.equal(lookupQuery({ prompt: 'short', response: 'text' }), 'short\n\ntext')
})

test('chooseNoteToUpdate takes the most similar turn note, not the first in the list', () => {
	const hits = [turnNote('low', 0.71), turnNote('high', 0.93), turnNote('middle', 0.8)]
	assert.equal(chooseNoteToUpdate(hits, own('low', 'high', 'middle')).id, 'high')
})

test('chooseNoteToUpdate never takes a turn note the hook did not write, even when it is the most similar', () => {
	const hits = [turnNote('another-users', 0.99), turnNote('mine', 0.75)]
	assert.equal(chooseNoteToUpdate(hits, own('mine')).id, 'mine')
	assert.equal(chooseNoteToUpdate([turnNote('another-users', 0.99)], own('mine')), undefined)
})

test('chooseNoteToUpdate takes nothing when the hook knows no note of its own', () => {
	assert.equal(chooseNoteToUpdate([turnNote('note', 0.9)], own()), undefined)
	assert.equal(chooseNoteToUpdate([turnNote('note', 0.9)]), undefined)
})

test('chooseNoteToUpdate skips a fact the AI wrote, even when it is the most similar', () => {
	const fact = { id: 'fact', memory: 'DECISION 2026-10-16: the hook searches first', similarity: 0.99 }
	assert.equal(chooseNoteToUpdate([fact, turnNote('note', 0.75)], own('fact', 'note')).id, 'note')
})

test('chooseNoteToUpdate skips an old tool capture', () => {
	const capture = { id: 'capture', memory: 'Tool: Read\nInput: {}\nResult: {}', similarity: 0.99 }
	assert.equal(chooseNoteToUpdate([capture], own('capture')), undefined)
})

test('chooseNoteToUpdate skips a document chunk, because a chunk cannot be updated', () => {
	const chunk = { id: 'chunk', chunk: 'User prompt: text from a document', similarity: 0.99 }
	assert.equal(chooseNoteToUpdate([chunk, turnNote('note', 0.72)], own('chunk', 'note')).id, 'note')
	assert.equal(chooseNoteToUpdate([chunk], own('chunk')), undefined)
})

test('chooseNoteToUpdate accepts the summary form and the list form of a turn note', () => {
	const summary = { id: 'summary', memory: 'User prompt (summary): short\n\nResponse: done', similarity: 0.9 }
	const list = { id: 'list', memory: 'User prompt:\n1. first\n2. second\n\nResponse: done', similarity: 0.8 }
	assert.equal(chooseNoteToUpdate([summary], own('summary')).id, 'summary')
	assert.equal(chooseNoteToUpdate([list], own('list')).id, 'list')
})

test('chooseNoteToUpdate accepts exactly what the hook writes', async () => {
	const neverNeeded = async () => assert.fail('a short note needs no summary')
	const written = await memoryAddTurn({ prompt: 'fix it', thinking: 'plan', response: 'done' }, 10_000, neverNeeded)
	assert.equal(chooseNoteToUpdate([{ id: 'written', memory: written, similarity: 0.8 }], own('written')).id, 'written')
})

test('chooseNoteToUpdate gives nothing when there is nothing to choose from', () => {
	for (const hits of [[], undefined, null, 'text', {}, [{}], [null], [{ memory: 'User prompt: x' }]]) {
		assert.equal(chooseNoteToUpdate(hits, own('x')), undefined)
	}
	assert.equal(chooseNoteToUpdate([{ id: 5, memory: 'User prompt: x', similarity: 0.9 }], own(5)), undefined)
})
