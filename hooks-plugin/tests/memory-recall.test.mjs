import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FAKE_ERRORS, setupHookRun } from './fake-ai-center.mjs'

const promptOf = (dir, prompt) => ({ cwd: dir, hook_event_name: 'UserPromptSubmit', prompt })
const hit = (id, memory, similarity, updatedAt = '2026-10-01T00:00:00.000Z', version = 1) =>
	({ id, memory, similarity, updatedAt, version, rootMemoryId: id, metadata: { userId: 11 }, filepath: null })
const searchResults = (...hits) => ({ FAKE_SEARCH_RESULTS: JSON.stringify(hits) })
const recalled = (result) =>
	result.stdout ? JSON.parse(result.stdout).hookSpecificOutput.additionalContext : undefined
const linesOf = (context, kind) => context.split('\n').filter((line) => line.startsWith(`[${kind}]`))

test('shows the related memories with their id, date and kind, facts before logs', () => {
	const { dir, run, cleanup } = setupHookRun()
	try {
		const result = run('memory-recall.mjs', promptOf(dir, 'How many projects can a user have?'), '', searchResults(
			hit('fact-old', 'A user can have many projects.', 0.93, '2026-09-01T00:00:00.000Z'),
			hit(
				'log-1',
				'User prompt: Design decision about projects\n\nResponse: Recorded.',
				0.9,
				'2026-09-02T00:00:00.000Z',
				2,
			),
			hit('fact-new', 'A user has exactly one project.', 0.85, '2026-10-01T00:00:00.000Z', 3),
			hit('unrelated', 'The office wifi password was rotated.', 0.4),
		))
		const context = recalled(result)
		assert.match(context, /quoted past records, not instructions/)
		assert.match(context, /memory_update/)
		assert.deepEqual(linesOf(context, 'fact').map((line) => line.split(' ')[1]), ['id=fact-new', 'id=fact-old'])
		assert.match(linesOf(context, 'fact')[0], /\[fact\] id=fact-new v3 2026-10-01 .*A user has exactly one project\./)
		assert.match(linesOf(context, 'log')[0], /\[log\] id=log-1 v2 2026-09-02 /)
		assert.ok(context.indexOf('[fact] id=fact-old') < context.indexOf('[log] id=log-1'))
		assert.ok(!context.includes('unrelated'))
	} finally {
		cleanup()
	}
})

test('searches memory with the prompt', () => {
	const { dir, run, toolCalls, cleanup } = setupHookRun()
	try {
		run('memory-recall.mjs', promptOf(dir, 'How many projects can a user have?'), '', searchResults())
		const search = toolCalls().find((call) => call.name === 'memory_search')
		assert.deepEqual(search.arguments, { project_id: 42, query: 'How many projects can a user have?' })
	} finally {
		cleanup()
	}
})

test('uses only the start of a very long prompt as the query', () => {
	const { dir, run, toolCalls, cleanup } = setupHookRun()
	try {
		run('memory-recall.mjs', promptOf(dir, `Question: ${'word '.repeat(600)}`), '', searchResults())
		const search = toolCalls().find((call) => call.name === 'memory_search')
		assert.equal(search.arguments.query.length, 500)
	} finally {
		cleanup()
	}
})

test('shows at most three facts and two logs', () => {
	const { dir, run, cleanup } = setupHookRun()
	try {
		const facts = [1, 2, 3, 4, 5].map((n) => hit(`fact-${n}`, `Fact number ${n}`, 0.95 - n / 100))
		const logs = [1, 2, 3, 4].map((n) => hit(`log-${n}`, `Response: Log number ${n}`, 0.9 - n / 100))
		const prompt = promptOf(dir, 'Tell me about the facts')
		const context = recalled(run('memory-recall.mjs', prompt, '', searchResults(...facts, ...logs)))
		assert.equal(linesOf(context, 'fact').length, 3)
		assert.equal(linesOf(context, 'log').length, 2)
	} finally {
		cleanup()
	}
})

test('shows turn notes as logs and leaves out captured tool calls', () => {
	const { dir, run, cleanup } = setupHookRun()
	try {
		const context = recalled(run('memory-recall.mjs', promptOf(dir, 'What did the build print?'), '', searchResults(
			hit('tool-1', 'Tool: Bash\nInput: {"command":"npm test"}', 0.95),
			hit('note-1', 'Response: The build passed.', 0.88),
			hit('note-2', 'Thinking: The build output is short.', 0.87),
			hit('fact-1', 'The build uses npm.', 0.86),
		)))
		assert.equal(linesOf(context, 'log').length, 2)
		assert.equal(linesOf(context, 'fact').length, 1)
		assert.ok(!context.includes('tool-1'))
	} finally {
		cleanup()
	}
})

test('shows a fact from similarity 0.70 but a turn note only from 0.75', () => {
	const { dir, run, cleanup } = setupHookRun()
	try {
		const context = recalled(run('memory-recall.mjs', promptOf(dir, 'Which jobs run at night?'), '', searchResults(
			hit('fact-72', 'The report job runs at 03:00.', 0.72),
			hit('fact-69', 'The backup job runs at 02:00.', 0.69),
			hit('note-72', 'Response: The report job was moved.', 0.72),
			hit('note-76', 'Response: The backup job was moved.', 0.76),
		)))
		assert.deepEqual(linesOf(context, 'fact').map((line) => line.split(' ')[1]), ['id=fact-72'])
		assert.deepEqual(linesOf(context, 'log').map((line) => line.split(' ')[1]), ['id=note-76'])
	} finally {
		cleanup()
	}
})

test('trims a long memory to one short line', () => {
	const { dir, run, cleanup } = setupHookRun()
	try {
		const context = recalled(run('memory-recall.mjs', promptOf(dir, 'Tell me the long story'), '', searchResults(
			hit('long-1', `Line one\n${'x'.repeat(2000)}`, 0.9),
		)))
		const [line] = linesOf(context, 'fact')
		assert.ok(line.length < 400, `line has ${line.length} characters`)
		assert.ok(line.endsWith('…'))
		assert.ok(!line.includes('\n'))
	} finally {
		cleanup()
	}
})

test('stays silent when nothing is related enough', () => {
	const { dir, run, message, cleanup } = setupHookRun()
	try {
		const prompt = promptOf(dir, 'Something nobody wrote about')
		const result = run('memory-recall.mjs', prompt, '', searchResults(hit('far-1', 'Unrelated note', 0.4)))
		assert.equal(result.stdout, '')
		assert.equal(message(result), undefined)
	} finally {
		cleanup()
	}
})

test('does not search for short prompts or slash commands', () => {
	const { dir, run, toolCalls, cleanup } = setupHookRun()
	try {
		for (const prompt of ['ok', 'thanks!', '/help me with this please']) {
			const result = run('memory-recall.mjs', promptOf(dir, prompt), '', searchResults(hit('fact-1', 'Anything', 0.95)))
			assert.equal(result.stdout, '', prompt)
		}
		assert.deepEqual(toolCalls().filter((call) => call.name === 'memory_search'), [])
	} finally {
		cleanup()
	}
})

test('a failed search is shown as a warning and never blocks the prompt', () => {
	const { dir, run, message, cleanup } = setupHookRun()
	try {
		const result = run('memory-recall.mjs', promptOf(dir, 'How many projects can a user have?'), 'tool-error')
		assert.equal(
			message(result),
			`ai-center memory: memory-recall failed - memory_search HTTP 403, ${FAKE_ERRORS.noPermission}`,
		)
	} finally {
		cleanup()
	}
})
