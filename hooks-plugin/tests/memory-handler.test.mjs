import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
	planTurnNote, buildTurnNote, isConversationLog, readTurnNote, findClosingBlock, dropRepeatedEntries,
	selectRecallEntries, badHitsDetection,
} from '../scripts/lib/note/memory-handler.mjs'

// Labels cost: 'User prompt: ' 13, 'User prompt (summary): ' 23, 'Response (summary): ' 20, blank line 2.
const LIMIT = 100

test('layer 1: keeps thinking when prompt, thinking and response fit the limit', () => {
	const plan = planTurnNote({ prompt: 'p', thinking: 't', response: 'r' }, LIMIT)
	assert.equal(plan.layer, 1)
	assert.equal(plan.includeThinking, true)
})

test('layer 2: drops thinking when only prompt and response fit the limit', () => {
	const plan = planTurnNote({ prompt: 'p', thinking: 't'.repeat(LIMIT), response: 'r' }, LIMIT)
	assert.equal(plan.layer, 2)
	assert.equal(plan.includeThinking, false)
})

test('layer 3a: prompt stays, response gets the remaining space', () => {
	const plan = planTurnNote({ prompt: 'p'.repeat(30), thinking: '', response: 'r'.repeat(LIMIT) }, LIMIT)
	assert.equal(plan.layer, '3a')
	assert.equal(plan.includeThinking, false)
	assert.equal(plan.promptBudget, null)
	// 100 - 'User prompt: ' (13) - 30 prompt - blank line (2) - 'Response (summary): ' (20)
	assert.equal(plan.responseBudget, 35)
})

test('a prompt of exactly half the limit is still layer 3a', () => {
	const plan = planTurnNote({ prompt: 'p'.repeat(LIMIT / 2), response: 'r'.repeat(LIMIT) }, LIMIT)
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

test('buildTurnNote layer 1: saves all three sections unchanged', async () => {
	const { summarize, calls } = fakeSummarizer()
	const note = await buildTurnNote({ prompt: 'p', thinking: 't', response: 'r' }, LIMIT, summarize)
	assert.equal(note, 'User prompt: p\n\nThinking:\nt\n\nResponse: r')
	assert.deepEqual(calls, [])
})

test('buildTurnNote puts a numbered list of prompts under one label, without a trailing space', async () => {
	const { summarize } = fakeSummarizer()
	const note = await buildTurnNote({ prompt: '\n1. first\n2. second', response: 'r' }, LIMIT, summarize)
	assert.equal(note, 'User prompt:\n1. first\n2. second\n\nResponse: r')
})

test('buildTurnNote layer 2: leaves the thinking out', async () => {
	const { summarize, calls } = fakeSummarizer()
	const note = await buildTurnNote({ prompt: 'p', thinking: 't'.repeat(LIMIT), response: 'r' }, LIMIT, summarize)
	assert.equal(note, 'User prompt: p\n\nResponse: r')
	assert.deepEqual(calls, [])
})

test('buildTurnNote layer 3a: only the response is summarized, into the remaining space', async () => {
	const { summarize, calls } = fakeSummarizer()
	const prompt = 'p'.repeat(30)
	const note = await buildTurnNote({ prompt, thinking: '', response: 'r'.repeat(LIMIT) }, LIMIT, summarize)
	assert.deepEqual(calls, [{ text: 'r'.repeat(LIMIT), budget: 35 }])
	assert.equal(note, `User prompt: ${prompt}\n\nResponse (summary): S35`)
})

test('buildTurnNote layer 3b: prompt and response are both summarized', async () => {
	const { summarize, calls } = fakeSummarizer()
	const note = await buildTurnNote({ prompt: 'p'.repeat(60), response: 'r'.repeat(60) }, LIMIT, summarize)
	assert.deepEqual(calls.map((call) => call.budget).sort(), [27, 28])
	assert.equal(note, 'User prompt (summary): S27\n\nResponse (summary): S28')
})

test('buildTurnNote layer 3b: a field that already fits its share is not summarized', async () => {
	const { summarize, calls } = fakeSummarizer()
	const note = await buildTurnNote({ prompt: 'p'.repeat(80), response: 'r'.repeat(10) }, LIMIT, summarize)
	assert.equal(calls.length, 1)
	assert.equal(note, `User prompt (summary): S27\n\nResponse: ${'r'.repeat(10)}`)
})

test('buildTurnNote passes a failing summarizer on, so nothing half-made is saved', async () => {
	const failing = async () => {
		throw new Error('summary failed')
	}
	await assert.rejects(
		buildTurnNote({ prompt: 'p', response: 'r'.repeat(LIMIT) }, LIMIT, failing),
		/summary failed/,
	)
})

test('layer 3b: a prompt over half the limit is summarized too, sharing the space', () => {
	const plan = planTurnNote({ prompt: 'p'.repeat(60), thinking: '', response: 'r'.repeat(60) }, LIMIT)
	assert.equal(plan.layer, '3b')
	// 100 - 'User prompt (summary): ' (23) - blank line (2) - 'Response (summary): ' (20) = 55, split in half
	assert.equal(plan.promptBudget, 27)
	assert.equal(plan.responseBudget, 28)
})

test('a limit that cannot hold the labels is refused with a clear message', () => {
	// Layer 3a: 30 - 'User prompt: ' (13) - 1 prompt - blank line (2) - 'Response (summary): ' (20) is below zero.
	assert.throws(() => planTurnNote({ prompt: 'p', response: 'r'.repeat(100) }, 30), /too small/)
	// Layer 3b: 40 - 23 - 2 - 20 is below zero.
	assert.throws(() => planTurnNote({ prompt: 'p'.repeat(60), response: 'r'.repeat(60) }, 40), /too small/)
})

test('a limit that is not a positive whole number is refused', () => {
	for (const limit of [undefined, 0, -5, 10.5, Number.NaN]) {
		assert.throws(() => planTurnNote({ prompt: 'p', response: 'r' }, limit), /positive whole number/)
	}
})

test('buildTurnNote passes the refusal on, so no summary is asked for', async () => {
	const { summarize, calls } = fakeSummarizer()
	await assert.rejects(buildTurnNote({ prompt: 'p', response: 'r'.repeat(100) }, 30, summarize), /too small/)
	assert.deepEqual(calls, [])
})

test('ordinary and summarized conversation records are logs, not facts', () => {
	for (const text of ['User prompt: task', 'User prompt (summary): task', 'Response: result', 'Response (summary): result', 'Thinking:\nplan']) {
		assert.equal(isConversationLog(text), true, text)
	}
	assert.equal(isConversationLog('The backend uses MySQL.'), false)
})

test('readTurnNote reads the prompt and the response of a note', () => {
	assert.deepEqual(readTurnNote('User prompt: p\n\nResponse: r'), { prompt: 'p', response: 'r' })
})

test('readTurnNote reads the summary labels like the plain ones', () => {
	const note = 'User prompt (summary): short ask\n\nResponse (summary): short answer'
	assert.deepEqual(readTurnNote(note), { prompt: 'short ask', response: 'short answer' })
})

test('readTurnNote reads several prompts stored as a numbered list under one label', () => {
	const note = 'User prompt:\n1. first\n2. second\n\nResponse: r'
	assert.deepEqual(readTurnNote(note), { prompt: '1. first\n2. second', response: 'r' })
})

test('readTurnNote leaves the thinking out, even when it has blank lines', () => {
	const note = 'User prompt: p\n\nThinking:\nsecret one\n\nsecret two\n\nResponse: r'
	assert.deepEqual(readTurnNote(note), { prompt: 'p', response: 'r' })
})

test('readTurnNote gives an empty response for a note that has none', () => {
	assert.deepEqual(readTurnNote('User prompt: only a prompt'), { prompt: 'only a prompt', response: '' })
})

test('readTurnNote reads a response that starts on a new line', () => {
	const note = 'User prompt: p\n\nResponse:\nline one\nline two'
	assert.deepEqual(readTurnNote(note), { prompt: 'p', response: 'line one\nline two' })
})

test('readTurnNote gives null for text that is not a turn note', () => {
	for (const text of ['The backend uses MySQL.', '', 'Response: r', undefined, null, 42]) {
		assert.equal(readTurnNote(text), null, String(text))
	}
})

test('readTurnNote gives back what buildTurnNote wrote, in every layer', async () => {
	const { summarize } = fakeSummarizer()
	const prompt30 = 'p'.repeat(30)
	const cases = [
		[{ prompt: 'p', thinking: 't', response: 'r' }, { prompt: 'p', response: 'r' }],
		[{ prompt: 'p', thinking: 't'.repeat(LIMIT), response: 'r' }, { prompt: 'p', response: 'r' }],
		[{ prompt: '\n1. first\n2. second', response: 'r' }, { prompt: '1. first\n2. second', response: 'r' }],
		[{ prompt: prompt30, response: 'r'.repeat(LIMIT) }, { prompt: prompt30, response: 'S35' }],
		[{ prompt: 'p'.repeat(60), response: 'r'.repeat(60) }, { prompt: 'S27', response: 'S28' }],
	]
	for (const [turn, expected] of cases) {
		assert.deepEqual(readTurnNote(await buildTurnNote(turn, LIMIT, summarize)), expected)
	}
})

test('findClosingBlock is the last paragraph when the reply asks nothing', () => {
	assert.equal(findClosingBlock('One.\n\nTwo.\n\nThree.'), 'Three.')
})

test('findClosingBlock starts at the paragraph of the last question and runs to the end', () => {
	assert.equal(findClosingBlock('Early?\n\nMiddle.\n\nFinal question?\n\nAfter it.'), 'Final question?\n\nAfter it.')
})

test('findClosingBlock keeps a heading with its list of questions together', () => {
	const reply = 'Summary.\n\n## Decisions\n1. First?\n2. Second?'
	assert.equal(findClosingBlock(reply), '## Decisions\n1. First?\n2. Second?')
})

test('findClosingBlock treats a line with only spaces as a blank line, and an empty reply gives nothing', () => {
	assert.equal(findClosingBlock('One.\n   \nTwo.'), 'Two.')
	assert.equal(findClosingBlock(''), '')
})

test('findClosingBlock falls back to the last paragraph when the question block is longer than the limit', () => {
	const reply = 'Quote of the user?\n\nA long middle part of the reply.\n\nSay OK and I will start.'
	const block = 'Quote of the user?\n\nA long middle part of the reply.\n\nSay OK and I will start.'
	assert.equal(findClosingBlock(reply, block.length - 1), 'Say OK and I will start.')
})

test('findClosingBlock keeps a question block that is exactly as long as the limit', () => {
	const reply = 'Intro.\n\nKeep this?\n\nThe end.'
	assert.equal(findClosingBlock(reply, 'Keep this?\n\nThe end.'.length), 'Keep this?\n\nThe end.')
})

test('findClosingBlock gives a last paragraph that is longer than the limit all the same', () => {
	assert.equal(findClosingBlock('Why?\n\nA very long ending paragraph.', 5), 'A very long ending paragraph.')
})

const item = (id, memory) => ({ id, memory })

test('dropRepeatedEntries keeps the first of two entries with the same id', () => {
	const kept = dropRepeatedEntries([item('a', 'first text here'), item('a', 'another wording entirely')])
	assert.deepEqual(kept, [item('a', 'first text here')])
})

test('dropRepeatedEntries drops text that is the same apart from case, a leading date and punctuation', () => {
	const kept = dropRepeatedEntries([
		item('a', '[2026-11-04] The user forbids committing unless explicitly asked.'),
		item('b', 'the USER  forbids committing; unless explicitly asked!'),
	])
	assert.deepEqual(kept.map((entry) => entry.id), ['a'])
})

test('dropRepeatedEntries drops an entry sharing 0.6 of its words, and keeps one sharing 0.5', () => {
	const kept = dropRepeatedEntries([
		item('a1', 'alpha beta gamma delta'),
		item('a2', 'alpha beta gamma omega'),
		item('b1', 'sigma kappa lambda'),
		item('b2', 'sigma kappa theta'),
	])
	assert.deepEqual(kept.map((entry) => entry.id), ['a1', 'b1', 'b2'])
})

test('dropRepeatedEntries does not count words of two letters or fewer', () => {
	const kept = dropRepeatedEntries([item('a', 'alpha beta gamma'), item('b', 'alpha beta gamma is to of a')])
	assert.deepEqual(kept.map((entry) => entry.id), ['a'])
})

test('dropRepeatedEntries keeps two different rules that share only common words', () => {
	const kept = dropRepeatedEntries([
		item('a', 'The user requires tests first.'),
		item('b', 'The user requires lines under 120 characters.'),
	])
	assert.deepEqual(kept.map((entry) => entry.id), ['a', 'b'])
})

test('dropRepeatedEntries lets a stronger wording take the place of the first one', () => {
	const kept = dropRepeatedEntries([
		item('a', 'The user prefers work to proceed one step at a time.'),
		item('b', 'The user keeps replies in plain words.'),
		item('c', 'The user requires work to proceed one step at a time.'),
	])
	assert.deepEqual(kept, [
		item('c', 'The user requires work to proceed one step at a time.'),
		item('b', 'The user keeps replies in plain words.'),
	])
})

test('dropRepeatedEntries lets a prohibition take the place of an earlier requirement', () => {
	const kept = dropRepeatedEntries([
		item('a', 'The user requires work to proceed one step at a time.'),
		item('b', 'The user forbids work to proceed one step at a time.'),
	])
	assert.deepEqual(kept.map((entry) => entry.id), ['b'])
})

test('dropRepeatedEntries sees text made only of short words as the same apart from case and punctuation', () => {
	const kept = dropRepeatedEntries([item('a', 'Go on'), item('b', 'go on!')])
	assert.deepEqual(kept.map((entry) => entry.id), ['a'])
})

test('dropRepeatedEntries ignores a leading date when it compares text made only of short words', () => {
	const kept = dropRepeatedEntries([item('a', '[2026-11-04] Go on'), item('b', 'go on')])
	assert.deepEqual(kept.map((entry) => entry.id), ['a'])
})

test('dropRepeatedEntries counts prohibits as a prohibition, like forbids', () => {
	const kept = dropRepeatedEntries([
		item('a', 'The user requires work to proceed one step at a time.'),
		item('b', 'The user prohibits work to proceed one step at a time.'),
	])
	assert.deepEqual(kept.map((entry) => entry.id), ['b'])
})

test('dropRepeatedEntries keeps only the longer of two entries when 0.8 of the shorter one is inside it', () => {
	const short = item('s', 'The user forbids editing `admin-ui/components.d.ts`.')
	const long = item('l', 'The user prohibits `git add .` and prohibits editing `admin-ui/components.d.ts`.')
	assert.deepEqual(dropRepeatedEntries([short, long]), [long])
	assert.deepEqual(dropRepeatedEntries([long, short]), [long])
})

test('dropRepeatedEntries keeps both entries when less than 0.8 of the shorter one is inside the longer', () => {
	const kept = dropRepeatedEntries([
		item('s', 'alpha beta gamma delta epsilon'),
		item('l', 'alpha beta gamma sigma kappa lambda omega'),
	])
	assert.deepEqual(kept.map((entry) => entry.id), ['s', 'l'])
})

test('dropRepeatedEntries keeps both entries when three of the four words of the shorter one are inside', () => {
	const kept = dropRepeatedEntries([
		item('s', 'alpha beta gamma delta'),
		item('l', 'alpha beta gamma sigma kappa lambda omega zeta'),
	])
	assert.deepEqual(kept.map((entry) => entry.id), ['s', 'l'])
})

test('dropRepeatedEntries merges at exactly 0.8 of the shorter one being inside the longer', () => {
	const kept = dropRepeatedEntries([
		item('s', 'alpha beta gamma delta epsilon'),
		item('l', 'alpha beta gamma delta sigma kappa lambda omega'),
	])
	assert.deepEqual(kept.map((entry) => entry.id), ['l'])
})

test('dropRepeatedEntries never swallows an entry of fewer than 4 words into a longer one', () => {
	const longer = 'alpha beta gamma delta epsilon zeta omega sigma'
	const withThree = dropRepeatedEntries([item('s', 'alpha beta gamma'), item('l', longer)])
	const withFour = dropRepeatedEntries([item('s', 'alpha beta gamma delta'), item('l', longer)])
	assert.deepEqual(withThree.map((entry) => entry.id), ['s', 'l'])
	assert.deepEqual(withFour.map((entry) => entry.id), ['l'])
})

test('dropRepeatedEntries keeps a shorter entry that is stronger than the longer one that holds its words', () => {
	const kept = dropRepeatedEntries([
		item('s', 'forbids sharing passwords tokens secrets'),
		item('l', 'The user prefers sharing passwords tokens secrets only with trusted teammates'),
	])
	assert.deepEqual(kept.map((entry) => entry.id), ['s', 'l'])
})

test('dropRepeatedEntries keeps the first when the wordings are equally strong', () => {
	const kept = dropRepeatedEntries([
		item('a', 'The user forbids committing unless explicitly asked.'),
		item('b', 'The user requires never committing changes unless explicitly asked.'),
	])
	assert.deepEqual(kept.map((entry) => entry.id), ['a'])
})

test('dropRepeatedEntries tells apart different rules written in other languages', () => {
	const kept = dropRepeatedEntries([
		item('a', '用户要求先写测试'),
		item('b', '用户禁止提交代码'),
		item('c', '用户要求先写测试'),
		item('d', 'Règle: écrire les tests d’abord'),
	])
	assert.deepEqual(kept.map((entry) => entry.id), ['a', 'b', 'd'])
})

test('dropRepeatedEntries never merges entries that have no id', () => {
	const kept = dropRepeatedEntries([
		item(null, 'alpha beta gamma'), { memory: 'sigma kappa lambda' }, item(undefined, 'omega theta zeta'),
	])
	assert.equal(kept.length, 3)
})

test('dropRepeatedEntries gives back only the id and the text of each entry', () => {
	const kept = dropRepeatedEntries([{ id: 'a', memory: 'alpha beta gamma', extra: 'x' }])
	assert.deepEqual(kept, [{ id: 'a', memory: 'alpha beta gamma' }])
})

const passage = (updatedAt, similarity = 0.9) => ({
	id: 'c-1', memory: null, chunk: 'A passage.', similarity, system: { updatedAt },
	included: { document: { id: 'doc-1', title: 'A note', system: { updatedAt } } },
})

test('selectRecallEntries recalls a passage of a document touched a moment ago', () => {
	assert.equal(selectRecallEntries([passage(new Date().toISOString())]).length, 1)
})

test('selectRecallEntries keeps a hit of any similarity, since the backend has applied the threshold', () => {
	assert.equal(selectRecallEntries([passage('2026-01-01T00:00:00.000Z', 0.01)]).length, 1)
})

test('selectRecallEntries recalls a passage of a document that has no date', () => {
	assert.equal(selectRecallEntries([passage(undefined)]).length, 1)
})

test('badHitsDetection says nothing when every hit can be used', () => {
	assert.deepEqual(badHitsDetection([passage('2026-01-01T00:00:00.000Z')]), [])
})
