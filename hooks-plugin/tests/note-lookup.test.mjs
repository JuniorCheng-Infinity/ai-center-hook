import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
	LOOKUP_QUERY_MAX_CHARS,
	chooseNoteToUpdate,
	buildLookupQuery,
	hasNoSourceDocuments,
} from '../scripts/lib/note/note-lookup.mjs'
import { buildTurnNote } from '../scripts/lib/note/memory-handler.mjs'

const documentOf = (id, title) => ({ document: { id: `doc-${id}`, title } })

// A hit as v5 gives it: the text is a fact Supermemory made, and the source document says what it came from.
const turnNote = (id, similarity, prompt = 'fix the login bug') => ({
	id,
	memory: 'The login bug is fixed.',
	similarity,
	included: documentOf(id, `User prompt: ${prompt}\n\nResponse: done`),
})

test('buildLookupQuery joins the prompt and the response, without the thinking', () => {
	assert.equal(buildLookupQuery({ prompt: 'fix the login bug', response: 'Fixed.' }), 'fix the login bug\n\nFixed.')
})

test('buildLookupQuery uses the one that exists when the other is empty', () => {
	assert.equal(buildLookupQuery({ prompt: 'fix it', response: '' }), 'fix it')
	assert.equal(buildLookupQuery({ prompt: '', response: 'Done.' }), 'Done.')
	assert.equal(buildLookupQuery({}), '')
	assert.equal(buildLookupQuery(), '')
})

test('buildLookupQuery drops the blank lines a list of prompts starts with', () => {
	assert.equal(buildLookupQuery({ prompt: '\n1. first\n2. second', response: 'ok' }), '1. first\n2. second\n\nok')
})

test('buildLookupQuery is cut at the limit, and a short text is left alone', () => {
	const cut = buildLookupQuery({ prompt: 'a'.repeat(LOOKUP_QUERY_MAX_CHARS), response: 'b'.repeat(50) })
	assert.equal(cut.length, LOOKUP_QUERY_MAX_CHARS)
	assert.equal(buildLookupQuery({ prompt: 'short', response: 'text' }), 'short\n\ntext')
})

test('chooseNoteToUpdate takes the most similar turn note, not the first in the list', () => {
	const hits = [turnNote('low', 0.71), turnNote('high', 0.93), turnNote('middle', 0.8)]
	assert.equal(chooseNoteToUpdate(hits).id, 'high')
})

test('chooseNoteToUpdate recognises a turn note by its document, not by the text of the memory', () => {
	const chosen = chooseNoteToUpdate([turnNote('note', 0.8)])
	assert.equal(chosen.memory, 'The login bug is fixed.')
	assert.equal(chosen.included.document.id, 'doc-note')
})

test('chooseNoteToUpdate skips a fact the AI wrote, even when it is the most similar', () => {
	const fact = {
		id: 'fact',
		memory: 'The hook searches first.',
		similarity: 0.99,
		included: documentOf('fact', 'DECISION 2026-10-16: the hook searches first'),
	}
	assert.equal(chooseNoteToUpdate([fact, turnNote('note', 0.75)]).id, 'note')
})

test('chooseNoteToUpdate skips an old tool capture', () => {
	const capture = {
		id: 'capture',
		memory: 'Tool: Read',
		similarity: 0.99,
		included: documentOf('capture', 'Tool: Read\nInput: {}\nResult: {}'),
	}
	assert.equal(chooseNoteToUpdate([capture]), undefined)
})

test('chooseNoteToUpdate accepts a chunk of a turn note, because its document is what gets updated', () => {
	const chunk = {
		id: 'chunk',
		chunk: 'User prompt: fix it\n\nResponse: done',
		similarity: 0.9,
		included: documentOf('chunk', 'User prompt: fix it\n\nResponse: done'),
	}
	assert.equal(chooseNoteToUpdate([chunk]).id, 'chunk')
})

test('chooseNoteToUpdate skips a chunk of a document that is not a turn note', () => {
	const chunk = {
		id: 'chunk',
		chunk: 'text from a manual',
		similarity: 0.99,
		included: documentOf('chunk', 'The manual of the build tool'),
	}
	assert.equal(chooseNoteToUpdate([chunk, turnNote('note', 0.72)]).id, 'note')
	assert.equal(chooseNoteToUpdate([chunk]), undefined)
})

test('chooseNoteToUpdate picks the most similar of memories and chunks together', () => {
	const chunk = {
		id: 'chunk',
		chunk: 'x',
		similarity: 0.95,
		included: documentOf('chunk', 'User prompt: other work\n\nResponse: done'),
	}
	assert.equal(chooseNoteToUpdate([turnNote('memory', 0.9), chunk]).id, 'chunk')
	assert.equal(chooseNoteToUpdate([turnNote('memory', 0.97), chunk]).id, 'memory')
})

test('chooseNoteToUpdate accepts the summary form and the list form of a turn note', () => {
	const summary = {
		id: 'summary',
		memory: 'fact',
		similarity: 0.9,
		included: documentOf('summary', 'User prompt (summary): short\n\nResponse: done'),
	}
	const list = {
		id: 'list',
		memory: 'fact',
		similarity: 0.8,
		included: documentOf('list', 'User prompt:\n1. first\n2. second\n\nResponse: done'),
	}
	assert.equal(chooseNoteToUpdate([summary]).id, 'summary')
	assert.equal(chooseNoteToUpdate([list]).id, 'list')
})

test('chooseNoteToUpdate accepts the title of exactly what the hook writes', async () => {
	const neverNeeded = async () => assert.fail('a short note needs no summary')
	const written = await buildTurnNote({ prompt: 'fix it', thinking: 'plan', response: 'done' }, 10_000, neverNeeded)
	// Supermemory cuts a title to its first 50 characters.
	const title = `${written.slice(0, 50)}...`
	const hit = { id: 'written', memory: 'fact', similarity: 0.8, included: documentOf('written', title) }
	assert.equal(chooseNoteToUpdate([hit]).id, 'written')
})

test('chooseNoteToUpdate gives nothing when there is nothing to choose from', () => {
	const noDocumentId = { id: 'a', similarity: 0.9, included: { document: { title: 'User prompt: x' } } }
	const noTitle = { id: 'a', similarity: 0.9, included: { document: { id: 'd' } } }
	const badTitle = { id: 'a', similarity: 0.9, included: { document: { id: 'd', title: 5 } } }
	const noDocument = { id: 'a', memory: 'User prompt: x', similarity: 0.9, included: null }
	const noIncluded = { id: 'a', memory: 'User prompt: x', similarity: 0.9 }
	for (const hits of [[], undefined, null, 'text', {}, [{}], [null], noDocumentId, [noDocumentId], [noTitle], [badTitle], [noDocument], [noIncluded]]) {
		assert.equal(chooseNoteToUpdate(hits), undefined)
	}
	assert.equal(chooseNoteToUpdate([{ id: 5, similarity: 0.9, included: documentOf('x', 'User prompt: x') }]), undefined)
})

test('hasNoSourceDocuments says when hits come back without a source document', () => {
	assert.equal(hasNoSourceDocuments([{ id: 'a', memory: 'fact', included: null }]), true)
	assert.equal(hasNoSourceDocuments([{ id: 'a', memory: 'fact' }, { id: 'b', included: { related: null } }]), true)
	assert.equal(hasNoSourceDocuments([turnNote('note', 0.9)]), false)
	assert.equal(hasNoSourceDocuments([{ id: 'a', included: null }, turnNote('note', 0.9)]), false)
	for (const hits of [[], undefined, null, 'text']) assert.equal(hasNoSourceDocuments(hits), false)
})
