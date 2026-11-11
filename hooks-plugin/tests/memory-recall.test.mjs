import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FAKE_ERRORS, setupHookRun } from './fake-ai-center.mjs'

const promptOf = (dir, prompt) => ({ cwd: dir, hook_event_name: 'UserPromptSubmit', prompt })
const hit = (id, memory, similarity, updatedAt = '2026-10-01T00:00:00.000Z') =>
	({ id, memory, chunk: null, metadata: { userId: 11 }, similarity, isLatest: true, isInference: false, system: { updatedAt, createdAt: '2026-01-01T00:00:00.000Z' }, included: null })
const searchResults = (...hits) => ({ FAKE_SEARCH_RESULTS: JSON.stringify(hits) })

// One hour in milliseconds, to date a document relative to now.
const HOUR = 3_600_000
// A day long ago, so a document with this date is never counted as touched recently.
const OLD_DATE = '2026-10-01T00:00:00.000Z'
// The environment Codex gives a hook, so that a test can run the hook as Codex.
const CODEX = { CLAUDECODE: '', PLUGIN_ROOT: '/home/user/.codex/plugins/ai-assistant-mem' }
const hoursAgo = (hours) => new Date(Date.now() - hours * HOUR).toISOString()
const sourceDocument = (id, title = 'A note', updatedAt = OLD_DATE) =>
	({ id, title, type: 'text', metadata: {}, summary: null, system: { createdAt: OLD_DATE, updatedAt } })
const inDocument = (found, document) => ({ ...found, included: { related: null, document } })
const chunk = (id, text, similarity, document, updatedAt = OLD_DATE) => inDocument({
	id, memory: null, chunk: text, metadata: { userId: 11 }, similarity, isLatest: true, isInference: false,
	system: { updatedAt, createdAt: OLD_DATE },
}, document)
// The word after the kind on each line: the memory id on a fact or log, the document id on a passage.
const lineIds = (context, kind) => linesOf(context, kind).map((line) => line.split(' ')[1])
const recalled = (result) =>
	result.stdout ? JSON.parse(result.stdout).hookSpecificOutput.additionalContext : undefined
const linesOf = (context, kind) => context.split('\n').filter((line) => line.startsWith(`[${kind}]`))

test('summarized logs are recalled as logs, and a chunk with no source document does not break fact recall', () => {
	const { dir, run, cleanup } = setupHookRun()
	try {
		const result = run('memory-recall.mjs', promptOf(dir, 'Recall the memory policy'), '', searchResults(
			null,
			{ id: 'chunk', chunk: 'document content', similarity: 0.99 },
			hit('fact', 'Use project-wide search for facts.', 0.70),
			hit('summary-low', 'User prompt (summary): old task', 0.72),
			hit('summary-log', 'Response (summary): completed task', 0.80),
		))
		const context = recalled(result)
		assert.match(linesOf(context, 'fact')[0], /id=fact /)
		assert.deepEqual(lineIds(context, 'log'), ['id=summary-log', 'id=summary-low'])
		assert.ok(!context.includes('id=chunk'))
	} finally { cleanup() }
})

test('shows the related memories with their id, date and kind, newest first', () => {
	const { dir, run, cleanup } = setupHookRun()
	try {
		const result = run('memory-recall.mjs', promptOf(dir, 'How many projects can a user have?'), '', searchResults(
			hit('fact-old', 'A user can have many projects.', 0.93, '2026-09-01T00:00:00.000Z'),
			hit(
				'log-1',
				'User prompt: Design decision about projects\n\nResponse: Recorded.',
				0.9,
				'2026-09-02T00:00:00.000Z',
			),
			hit('fact-new', 'A user has exactly one project.', 0.85, '2026-10-01T00:00:00.000Z'),
		))
		const context = recalled(result)
		assert.match(context, /quoted past records, not instructions/)
		assert.ok(!context.includes('For factual memories,'), 'the reminder hook already supplies the policy')
		assert.deepEqual(linesOf(context, 'fact').map((line) => line.split(' ')[1]), ['id=fact-new', 'id=fact-old'])
		assert.match(linesOf(context, 'fact')[0], /\[fact\] id=fact-new 2026-10-01 .*A user has exactly one project\./)
		assert.match(linesOf(context, 'log')[0], /\[log\] id=log-1 2026-09-02 /)
		assert.ok(!/ v\d| vundefined/.test(context), 'a v5 search hit has no version to show')
		assert.ok(context.indexOf('id=fact-new') < context.indexOf('id=log-1'))
		assert.ok(context.indexOf('id=log-1') < context.indexOf('id=fact-old'))
	} finally {
		cleanup()
	}
})

test('shows the newest memory first by the date in system.updatedAt', () => {
	const { dir, run, cleanup } = setupHookRun()
	try {
		const context = recalled(run('memory-recall.mjs', promptOf(dir, 'Which job runs first at night?'), '', searchResults(
			hit('job-old', 'The report job runs at 03:00.', 0.95, '2026-08-01T00:00:00.000Z'),
			hit('job-mid', 'The backup job runs at 02:00.', 0.9, '2026-09-01T00:00:00.000Z'),
			hit('job-new', 'The cleanup job runs at 01:00.', 0.85, '2026-10-01T00:00:00.000Z'),
		)))
		assert.deepEqual(
			linesOf(context, 'fact').map((line) => line.split(' ')[1]),
			['id=job-new', 'id=job-mid', 'id=job-old'],
		)
	} finally {
		cleanup()
	}
})

test('still shows a memory when v5 sends no date for it', () => {
	const { dir, run, cleanup } = setupHookRun()
	try {
		const noDate = { ...hit('no-date', 'The export job has no date.', 0.9), system: { updatedAt: null, createdAt: null } }
		const noSystem = { ...hit('no-system', 'The import job has no system block.', 0.88), system: undefined }
		const context = recalled(run('memory-recall.mjs', promptOf(dir, 'Which jobs have no date?'), '', searchResults(
			noDate,
			noSystem,
			hit('dated', 'The mail job runs at 04:00.', 0.86),
		)))
		const lines = linesOf(context, 'fact')
		assert.deepEqual(lines.map((line) => line.split(' ')[1]), ['id=dated', 'id=no-date', 'id=no-system'])
		assert.ok(lines.every((line) => !line.includes('undefined') && !line.includes('null')))
		assert.match(lines[1], /id=no-date {2}The export job has no date\./)
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

test('shows at most three lines, the best matches first', () => {
	const { dir, run, cleanup } = setupHookRun()
	try {
		const facts = [1, 2, 3, 4, 5].map((n) => hit(`fact-${n}`, `Fact number ${n}`, 0.95 - n / 100))
		const logs = [1, 2, 3, 4].map((n) => hit(`log-${n}`, `Response: Log number ${n}`, 0.9 - n / 100))
		const prompt = promptOf(dir, 'Tell me about the facts')
		const context = recalled(run('memory-recall.mjs', prompt, '', searchResults(...facts, ...logs)))
		assert.deepEqual(lineIds(context, 'fact'), ['id=fact-1', 'id=fact-2', 'id=fact-3'])
		assert.equal(linesOf(context, 'log').length, 0)
	} finally {
		cleanup()
	}
})

test('lets a log take a slot when it matches better than a fact', () => {
	const { dir, run, cleanup } = setupHookRun()
	try {
		const context = recalled(run('memory-recall.mjs', promptOf(dir, 'Which jobs run at night?'), '', searchResults(
			hit('fact-80', 'The report job runs at 03:00.', 0.8),
			hit('fact-78', 'The backup job runs at 02:00.', 0.78),
			hit('fact-72', 'The mail job runs at 04:00.', 0.72),
			hit('log-90', 'Response: The jobs were moved.', 0.9),
		)))
		assert.deepEqual(lineIds(context, 'fact'), ['id=fact-80', 'id=fact-78'])
		assert.deepEqual(lineIds(context, 'log'), ['id=log-90'])
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

test('leaves the similarity threshold to the backend: a hit of any similarity is recalled', () => {
	const { dir, run, cleanup } = setupHookRun()
	try {
		const context = recalled(run('memory-recall.mjs', promptOf(dir, 'Which jobs run at night?'), '', searchResults(
			hit('fact-low', 'The report job runs at 03:00.', 0.55),
			hit('note-low', 'Response: The report job was moved.', 0.5),
			chunk('c-low', 'The report job is described here.', 0.45, sourceDocument('doc-low')),
		)))
		assert.deepEqual(lineIds(context, 'fact'), ['id=fact-low'])
		assert.deepEqual(lineIds(context, 'log'), ['id=note-low'])
		assert.deepEqual(lineIds(context, 'passage'), ['doc=doc-low'])
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

test('stays silent when the search finds nothing', () => {
	const { dir, run, message, cleanup } = setupHookRun()
	try {
		const prompt = promptOf(dir, 'Something nobody wrote about')
		const result = run('memory-recall.mjs', prompt, '', searchResults())
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

test('shows the source document after the memory id, with its title on one line', () => {
	const { dir, run, cleanup } = setupHookRun()
	try {
		const found = inDocument(
			hit('fact-1', 'A user has one project.', 0.9),
			sourceDocument('doc-1', 'Design note\n  about   projects'),
		)
		const prompt = promptOf(dir, 'How many projects can a user have?')
		const context = recalled(run('memory-recall.mjs', prompt, '', searchResults(found)))
		assert.match(
			linesOf(context, 'fact')[0],
			/^\[fact\] id=fact-1 doc=doc-1 "Design note about projects" 2026-10-01 A user has one project\.$/,
		)
	} finally {
		cleanup()
	}
})

test('leaves out the document part when a memory has no source document', () => {
	const { dir, run, cleanup } = setupHookRun()
	try {
		const prompt = promptOf(dir, 'How many projects can a user have?')
		const context = recalled(run('memory-recall.mjs', prompt, '', searchResults(
			hit('fact-1', 'A user has one project.', 0.9),
			inDocument(hit('fact-2', 'A project has many notes.', 0.85), null),
		)))
		const lines = linesOf(context, 'fact')
		assert.equal(lines.length, 2)
		for (const line of lines) assert.match(line, /^\[fact\] id=fact-\d 2026-10-01 /)
	} finally {
		cleanup()
	}
})

test('shows the document id alone when the title is missing', () => {
	const { dir, run, cleanup } = setupHookRun()
	try {
		const found = inDocument(hit('fact-1', 'A user has one project.', 0.9), sourceDocument('doc-1', null))
		const prompt = promptOf(dir, 'How many projects can a user have?')
		const context = recalled(run('memory-recall.mjs', prompt, '', searchResults(found)))
		assert.match(linesOf(context, 'fact')[0], /^\[fact\] id=fact-1 doc=doc-1 2026-10-01 A user has one project\.$/)
	} finally {
		cleanup()
	}
})

test('shows only the best memory of one document', () => {
	const { dir, run, cleanup } = setupHookRun()
	try {
		const same = sourceDocument('doc-5')
		const context = recalled(run('memory-recall.mjs', promptOf(dir, 'Which jobs run at night?'), '', searchResults(
			inDocument(hit('m-70', 'The report job runs at 03:00.', 0.78), same),
			inDocument(hit('m-90', 'The backup job runs at 02:00.', 0.9), same),
			hit('m-80', 'The mail job runs at 04:00.', 0.8),
		)))
		assert.deepEqual(lineIds(context, 'fact'), ['id=m-90', 'id=m-80'])
	} finally {
		cleanup()
	}
})

test('shows the best memory of a document when it arrives first', () => {
	const { dir, run, cleanup } = setupHookRun()
	try {
		const same = sourceDocument('doc-5')
		const context = recalled(run('memory-recall.mjs', promptOf(dir, 'Which jobs run at night?'), '', searchResults(
			inDocument(hit('m-90', 'The backup job runs at 02:00.', 0.9), same),
			inDocument(hit('m-70', 'The report job runs at 03:00.', 0.78), same),
		)))
		assert.deepEqual(lineIds(context, 'fact'), ['id=m-90'])
	} finally {
		cleanup()
	}
})

test('ranks a hit that has no similarity last', () => {
	const { dir, run, cleanup } = setupHookRun()
	try {
		const noSimilarity = hit('m-none', 'The mail job has no similarity.', undefined)
		const context = recalled(run('memory-recall.mjs', promptOf(dir, 'Which jobs run at night?'), '', searchResults(
			noSimilarity,
			hit('m-90', 'The backup job runs at 02:00.', 0.9),
			hit('m-80', 'The report job runs at 03:00.', 0.8),
			hit('m-70', 'The cleanup job runs at 01:00.', 0.7),
		)))
		assert.deepEqual(lineIds(context, 'fact'), ['id=m-90', 'id=m-80', 'id=m-70'])
	} finally {
		cleanup()
	}
})

test('does not recall a hit that has neither a memory nor a chunk, and reports nothing', () => {
	const { dir, run, failures, cleanup } = setupHookRun()
	try {
		const empty = inDocument(hit('empty', null, 0.9), sourceDocument('doc-empty'))
		const result = run('memory-recall.mjs', promptOf(dir, 'What does the note say?'), '', searchResults(empty))
		assert.equal(result.stdout, '')
		assert.deepEqual(failures(), [])
	} finally {
		cleanup()
	}
})

test('puts a memory before a passage that has the same date', () => {
	const { dir, run, cleanup } = setupHookRun()
	try {
		const context = recalled(run('memory-recall.mjs', promptOf(dir, 'Tell me about the notes'), '', searchResults(
			chunk('c-1', 'A passage text.', 0.95, sourceDocument('doc-a')),
			hit('fact-1', 'One fact.', 0.8),
		)))
		const order = context.split('\n').slice(1).map((line) => line.split(' ')[1])
		assert.deepEqual(order, ['id=fact-1', 'doc=doc-a'])
	} finally {
		cleanup()
	}
})

test('shows a passage when a document has a matching chunk and no memory line', () => {
	const { dir, run, cleanup } = setupHookRun()
	try {
		const prompt = promptOf(dir, 'What does the migration do?')
		const context = recalled(run('memory-recall.mjs', prompt, '', searchResults(
			chunk('c-1', 'The migration renames\nthe column.', 0.8, sourceDocument('doc-7', 'Migration note')),
		)))
		const [line] = linesOf(context, 'passage')
		assert.match(line, /^\[passage\] doc=doc-7 "Migration note" 2026-10-01 The migration renames the column\.$/)
		assert.ok(!line.includes('id='), 'a chunk id is of no use to the AI')
	} finally {
		cleanup()
	}
})

test('never shows a passage of a document that already has a memory line', () => {
	const { dir, run, cleanup } = setupHookRun()
	try {
		const same = sourceDocument('doc-1')
		const context = recalled(run('memory-recall.mjs', promptOf(dir, 'How many projects?'), '', searchResults(
			inDocument(hit('fact-1', 'A user has one project.', 0.85), same),
			chunk('c-same', 'The same note, as raw text.', 0.95, same),
			chunk('c-other', 'Another note, as raw text.', 0.8, sourceDocument('doc-2', 'Other note')),
		)))
		assert.deepEqual(lineIds(context, 'passage'), ['doc=doc-2'])
	} finally {
		cleanup()
	}
})

test('shows one passage per document, the best match', () => {
	const { dir, run, cleanup } = setupHookRun()
	try {
		const same = sourceDocument('doc-3')
		const context = recalled(run('memory-recall.mjs', promptOf(dir, 'What does the note say?'), '', searchResults(
			chunk('c-low', 'The weaker passage.', 0.72, same),
			chunk('c-high', 'The stronger passage.', 0.88, same),
		)))
		const passages = linesOf(context, 'passage')
		assert.equal(passages.length, 1)
		assert.match(passages[0], /The stronger passage\./)
	} finally {
		cleanup()
	}
})

test('fills only the free slots with passages, up to three lines in all', () => {
	const { dir, run, cleanup } = setupHookRun()
	try {
		const chunks = [1, 2, 3].map((n) =>
			chunk(`c-${n}`, `Passage number ${n}`, 0.9 - n / 100, sourceDocument(`doc-${n}`, `Note ${n}`)))
		const prompt = promptOf(dir, 'Tell me about the notes')
		const context = recalled(run('memory-recall.mjs', prompt, '', searchResults(
			hit('fact-1', 'One fact.', 0.9),
			hit('fact-2', 'Another fact.', 0.85),
			...chunks,
		)))
		assert.equal(linesOf(context, 'fact').length, 2)
		assert.deepEqual(lineIds(context, 'passage'), ['doc=doc-1'])
	} finally {
		cleanup()
	}
})

test('shows three passages when no memory matches', () => {
	const { dir, run, cleanup } = setupHookRun()
	try {
		const chunks = [1, 2, 3, 4, 5].map((n) =>
			chunk(`c-${n}`, `Passage number ${n}`, 0.95 - n / 100, sourceDocument(`doc-${n}`, `Note ${n}`)))
		const prompt = promptOf(dir, 'Tell me about the notes')
		const context = recalled(run('memory-recall.mjs', prompt, '', searchResults(...chunks)))
		assert.deepEqual(lineIds(context, 'passage'), ['doc=doc-1', 'doc=doc-2', 'doc=doc-3'])
	} finally {
		cleanup()
	}
})

test('shows no passage when three memories already fill the lines', () => {
	const { dir, run, cleanup } = setupHookRun()
	try {
		const context = recalled(run('memory-recall.mjs', promptOf(dir, 'Which jobs run at night?'), '', searchResults(
			hit('fact-1', 'The report job runs at 03:00.', 0.9),
			hit('fact-2', 'The backup job runs at 02:00.', 0.85),
			hit('fact-3', 'The mail job runs at 04:00.', 0.8),
			chunk('c-1', 'A raw passage about the jobs.', 0.99, sourceDocument('doc-1')),
		)))
		assert.equal(linesOf(context, 'fact').length, 3)
		assert.equal(linesOf(context, 'passage').length, 0)
	} finally {
		cleanup()
	}
})

test('skips a passage that is a captured tool call', () => {
	const { dir, run, cleanup } = setupHookRun()
	try {
		const context = recalled(run('memory-recall.mjs', promptOf(dir, 'What did the build print?'), '', searchResults(
			chunk('c-tool', 'Tool: Bash\nInput: {"command":"npm test"}', 0.95, sourceDocument('doc-t', 'Direct memories (1)')),
			chunk('c-real', 'The build passed.', 0.8, sourceDocument('doc-b', 'Build note')),
		)))
		assert.deepEqual(lineIds(context, 'passage'), ['doc=doc-b'])
	} finally {
		cleanup()
	}
})

test('shows a passage of a document that was just touched, since a new document has no memory yet', () => {
	const { dir, run, cleanup } = setupHookRun()
	try {
		const minuteAgo = hoursAgo(0.02)
		const context = recalled(run('memory-recall.mjs', promptOf(dir, 'What did we just do?'), '', searchResults(
			chunk('c-new', 'A note added a minute ago.', 0.9, sourceDocument('doc-new', 'New note', minuteAgo), minuteAgo),
			chunk('c-old', 'An older note.', 0.85, sourceDocument('doc-old', 'Older note', hoursAgo(5)), hoursAgo(5)),
		)))
		assert.deepEqual(lineIds(context, 'passage'), ['doc=doc-new', 'doc=doc-old'])
	} finally {
		cleanup()
	}
})

test('shows every line newest first, whatever its kind', () => {
	const { dir, run, cleanup } = setupHookRun()
	try {
		const context = recalled(run('memory-recall.mjs', promptOf(dir, 'Tell me about the notes'), '', searchResults(
			chunk('c-old', 'Older passage text.', 0.9, sourceDocument('doc-a'), '2026-08-01T00:00:00.000Z'),
			chunk('c-new', 'Newer passage text.', 0.85, sourceDocument('doc-b'), '2026-09-01T00:00:00.000Z'),
			hit('fact-1', 'One fact.', 0.8, '2026-07-01T00:00:00.000Z'),
		)))
		const order = context.split('\n').slice(1).map((line) => line.split(' ')[1])
		assert.deepEqual(order, ['doc=doc-b', 'doc=doc-a', 'id=fact-1'])
	} finally {
		cleanup()
	}
})

test('works the same when it runs for Codex', () => {
	const { dir, run, cleanup } = setupHookRun()
	try {
		const prompt = promptOf(dir, 'How many projects can a user have?')
		const hits = searchResults(
			inDocument(hit('fact-1', 'A user has one project.', 0.9), sourceDocument('doc-1', 'Design note')),
			chunk('c-1', 'The migration renames the column.', 0.8, sourceDocument('doc-7', 'Migration note')),
		)
		const context = recalled(run('memory-recall.mjs', prompt, '', { ...hits, ...CODEX }))
		assert.match(linesOf(context, 'fact')[0], /^\[fact\] id=fact-1 doc=doc-1 "Design note" /)
		assert.match(linesOf(context, 'passage')[0], /^\[passage\] doc=doc-7 "Migration note" /)
	} finally {
		cleanup()
	}
})

test('reports a search hit that cannot be read, then goes on without it', () => {
	const { dir, run, failures, cleanup } = setupHookRun()
	try {
		const prompt = promptOf(dir, 'How many projects can a user have?')
		const hits = searchResults(null, hit('fact-1', 'A user has one project.', 0.9))
		const result = run('memory-recall.mjs', prompt, '', hits)
		const recorded = failures()
		assert.equal(recorded.length, 1)
		assert.match(recorded[0].info, /search hits that cannot be read skipped: 1/)
		assert.equal(recorded[0].display, 'pending', 'the context is the only output of the hook')
		assert.equal(linesOf(recalled(result), 'fact').length, 1)
	} finally {
		cleanup()
	}
})

test('reports a chunk that names no source document, then goes on without it', () => {
	const { dir, run, failures, cleanup } = setupHookRun()
	try {
		const prompt = promptOf(dir, 'How many projects can a user have?')
		const result = run('memory-recall.mjs', prompt, '', searchResults(
			chunk('c-1', 'A passage with no document.', 0.9, null),
			inDocument(hit('fact-1', 'A user has one project.', 0.85), sourceDocument('doc-1')),
		))
		const recorded = failures()
		assert.equal(recorded.length, 1)
		assert.match(recorded[0].info, /chunk hits without a source document skipped: 1 \(is include\.documents on\?\)/)
		assert.equal(recorded[0].display, 'pending', 'the context is the only output of the hook')
		assert.equal(linesOf(recalled(result), 'passage').length, 0)
		assert.equal(linesOf(recalled(result), 'fact').length, 1)
	} finally {
		cleanup()
	}
})

test('reports nothing for a memory that has no source document', () => {
	const { dir, run, failures, cleanup } = setupHookRun()
	try {
		const prompt = promptOf(dir, 'How many projects can a user have?')
		run('memory-recall.mjs', prompt, '', searchResults(hit('fact-1', 'A user has one project.', 0.9)))
		assert.deepEqual(failures(), [])
	} finally {
		cleanup()
	}
})

test('does not recall a chunk that has no id, and says so', () => {
	const { dir, run, failures, cleanup } = setupHookRun()
	try {
		const noId = { ...chunk('c-x', 'A passage with no id.', 0.9, sourceDocument('doc-x')), id: undefined }
		const result = run('memory-recall.mjs', promptOf(dir, 'What does the note say?'), '', searchResults(noId))
		assert.equal(result.stdout, '')
		assert.match(failures()[0].info, /search hits that cannot be read skipped: 1/)
	} finally {
		cleanup()
	}
})

test('treats a hit that has both a memory and a chunk as a memory', () => {
	const { dir, run, cleanup } = setupHookRun()
	try {
		const both = inDocument(
			{ ...hit('both', 'Response: The note text.', 0.8), chunk: 'The raw text of the note.' },
			sourceDocument('doc-both', 'Both'),
		)
		const tool = inDocument(
			{ ...hit('tool', 'Tool: Bash\nInput: {"command":"npm test"}', 0.9), chunk: 'The raw tool text.' },
			sourceDocument('doc-tool', 'Tool note'),
		)
		const hits = searchResults(both, tool)
		const context = recalled(run('memory-recall.mjs', promptOf(dir, 'What does the note say?'), '', hits))
		assert.deepEqual(lineIds(context, 'log'), ['id=both'])
		assert.deepEqual(lineIds(context, 'passage'), [])
	} finally {
		cleanup()
	}
})

test('says so when a search hit has no id', () => {
	const { dir, run, failures, cleanup } = setupHookRun()
	try {
		const noId = { similarity: 0.9, memory: 'A memory without an id.' }
		const prompt = promptOf(dir, 'How many projects can a user have?')
		const hits = searchResults(noId, hit('fact-1', 'A user has one project.', 0.9))
		const result = run('memory-recall.mjs', prompt, '', hits)
		assert.match(failures()[0].info, /search hits that cannot be read skipped: 1/)
		assert.deepEqual(lineIds(recalled(result), 'fact'), ['id=fact-1'])
	} finally {
		cleanup()
	}
})

test('trims the title of the source document', () => {
	const { dir, run, cleanup } = setupHookRun()
	try {
		const found = inDocument(hit('fact-1', 'A user has one project.', 0.9), sourceDocument('doc-1', '  Design note  '))
		const prompt = promptOf(dir, 'How many projects can a user have?')
		const context = recalled(run('memory-recall.mjs', prompt, '', searchResults(found)))
		assert.match(linesOf(context, 'fact')[0], /^\[fact\] id=fact-1 doc=doc-1 "Design note" /)
	} finally {
		cleanup()
	}
})

test('searches a prompt of twelve characters and not one of eleven', () => {
	const { dir, run, toolCalls, cleanup } = setupHookRun()
	try {
		const searches = () => toolCalls().filter((call) => call.name === 'memory_search').length
		run('memory-recall.mjs', promptOf(dir, 'a'.repeat(11)), '', searchResults())
		assert.equal(searches(), 0)
		run('memory-recall.mjs', promptOf(dir, 'a'.repeat(12)), '', searchResults())
		assert.equal(searches(), 1)
	} finally {
		cleanup()
	}
})
