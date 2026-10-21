import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryAddContent, memoryAddTurn } from '../scripts/lib/note/memory-handler.mjs'

// Labels cost: 'User prompt: ' 13, 'User prompt (summary): ' 23, 'Response (summary): ' 20, blank line 2.
const LIMIT = 100

test('layer 1: keeps thinking when prompt, thinking and response fit the limit', () => {
	const plan = memoryAddContent({ prompt: 'p', thinking: 't', response: 'r' }, LIMIT)
	assert.equal(plan.layer, 1)
	assert.equal(plan.includeThinking, true)
})

test('layer 2: drops thinking when only prompt and response fit the limit', () => {
	const plan = memoryAddContent({ prompt: 'p', thinking: 't'.repeat(LIMIT), response: 'r' }, LIMIT)
	assert.equal(plan.layer, 2)
	assert.equal(plan.includeThinking, false)
})

test('layer 3a: prompt stays, response gets the remaining space', () => {
	const plan = memoryAddContent({ prompt: 'p'.repeat(30), thinking: '', response: 'r'.repeat(LIMIT) }, LIMIT)
	assert.equal(plan.layer, '3a')
	assert.equal(plan.includeThinking, false)
	assert.equal(plan.promptBudget, null)
	// 100 - 'User prompt: ' (13) - 30 prompt - blank line (2) - 'Response (summary): ' (20)
	assert.equal(plan.responseBudget, 35)
})

test('a prompt of exactly half the limit is still layer 3a', () => {
	const plan = memoryAddContent({ prompt: 'p'.repeat(LIMIT / 2), response: 'r'.repeat(LIMIT) }, LIMIT)
	assert.equal(plan.layer, '3a')
})

// The fake summarizer returns "S<budget>", so a test can see which budget each field was given.
function fakeSummarizer() {
	const calls = []
	const summarize = async (text, budget) => {
		calls.push({ text, budget })
		return `S${budget}`
	}
	return { summarize, calls }
}

test('memoryAddTurn layer 1: saves all three sections unchanged', async () => {
	const { summarize, calls } = fakeSummarizer()
	const note = await memoryAddTurn({ prompt: 'p', thinking: 't', response: 'r' }, LIMIT, summarize)
	assert.equal(note, 'User prompt: p\n\nThinking:\nt\n\nResponse: r')
	assert.deepEqual(calls, [])
})

test('memoryAddTurn puts a numbered list of prompts under one label, without a trailing space', async () => {
	const { summarize } = fakeSummarizer()
	const note = await memoryAddTurn({ prompt: '\n1. first\n2. second', response: 'r' }, LIMIT, summarize)
	assert.equal(note, 'User prompt:\n1. first\n2. second\n\nResponse: r')
})

test('memoryAddTurn layer 2: leaves the thinking out', async () => {
	const { summarize, calls } = fakeSummarizer()
	const note = await memoryAddTurn({ prompt: 'p', thinking: 't'.repeat(LIMIT), response: 'r' }, LIMIT, summarize)
	assert.equal(note, 'User prompt: p\n\nResponse: r')
	assert.deepEqual(calls, [])
})

test('memoryAddTurn layer 3a: only the response is summarized, into the remaining space', async () => {
	const { summarize, calls } = fakeSummarizer()
	const prompt = 'p'.repeat(30)
	const note = await memoryAddTurn({ prompt, thinking: '', response: 'r'.repeat(LIMIT) }, LIMIT, summarize)
	assert.deepEqual(calls, [{ text: 'r'.repeat(LIMIT), budget: 35 }])
	assert.equal(note, `User prompt: ${prompt}\n\nResponse (summary): S35`)
})

test('memoryAddTurn layer 3b: prompt and response are both summarized', async () => {
	const { summarize, calls } = fakeSummarizer()
	const note = await memoryAddTurn({ prompt: 'p'.repeat(60), response: 'r'.repeat(60) }, LIMIT, summarize)
	assert.deepEqual(calls.map((call) => call.budget).sort(), [27, 28])
	assert.equal(note, 'User prompt (summary): S27\n\nResponse (summary): S28')
})

test('memoryAddTurn layer 3b: a field that already fits its share is not summarized', async () => {
	const { summarize, calls } = fakeSummarizer()
	const note = await memoryAddTurn({ prompt: 'p'.repeat(80), response: 'r'.repeat(10) }, LIMIT, summarize)
	assert.equal(calls.length, 1)
	assert.equal(note, `User prompt (summary): S27\n\nResponse: ${'r'.repeat(10)}`)
})

test('memoryAddTurn passes a failing summarizer on, so nothing half-made is saved', async () => {
	const failing = async () => {
		throw new Error('summary failed')
	}
	await assert.rejects(
		memoryAddTurn({ prompt: 'p', response: 'r'.repeat(LIMIT) }, LIMIT, failing),
		/summary failed/,
	)
})

test('layer 3b: a prompt over half the limit is summarized too, sharing the space', () => {
	const plan = memoryAddContent({ prompt: 'p'.repeat(60), thinking: '', response: 'r'.repeat(60) }, LIMIT)
	assert.equal(plan.layer, '3b')
	// 100 - 'User prompt (summary): ' (23) - blank line (2) - 'Response (summary): ' (20) = 55, split in half
	assert.equal(plan.promptBudget, 27)
	assert.equal(plan.responseBudget, 28)
})

test('a limit that cannot hold the labels is refused with a clear message', () => {
	// Layer 3a: 30 - 'User prompt: ' (13) - 1 prompt - blank line (2) - 'Response (summary): ' (20) is below zero.
	assert.throws(() => memoryAddContent({ prompt: 'p', response: 'r'.repeat(100) }, 30), /too small/)
	// Layer 3b: 40 - 23 - 2 - 20 is below zero.
	assert.throws(() => memoryAddContent({ prompt: 'p'.repeat(60), response: 'r'.repeat(60) }, 40), /too small/)
})

test('a limit that is not a positive whole number is refused', () => {
	for (const limit of [undefined, 0, -5, 10.5, Number.NaN]) {
		assert.throws(() => memoryAddContent({ prompt: 'p', response: 'r' }, limit), /positive whole number/)
	}
})

test('memoryAddTurn passes the refusal on, so no summary is asked for', async () => {
	const { summarize, calls } = fakeSummarizer()
	await assert.rejects(memoryAddTurn({ prompt: 'p', response: 'r'.repeat(100) }, 30, summarize), /too small/)
	assert.deepEqual(calls, [])
})
