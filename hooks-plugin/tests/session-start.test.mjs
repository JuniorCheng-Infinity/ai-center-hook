import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupHookRun } from './fake-ai-center.mjs'

const startOf = (dir) => ({ cwd: dir, hook_event_name: 'SessionStart', source: 'startup' })
const hit = (id, memory) =>
  ({ id, memory, similarity: 0.8, updatedAt: '2026-10-01T00:00:00.000Z', version: 1, rootMemoryId: id, metadata: { userId: 11 }, filepath: null })
const searchResults = (...hits) => ({ FAKE_SEARCH_RESULTS: JSON.stringify(hits) })
const startedWith = (result) => JSON.parse(result.stdout).hookSpecificOutput.additionalContext

test('searches memory with the name of the project', () => {
  const { dir, run, toolCalls, cleanup } = setupHookRun()
  try {
    run('context.mjs', startOf(dir), '', searchResults())
    const search = toolCalls().find((call) => call.name === 'memory_search')
    assert.deepEqual(search.arguments, { project_id: 42, query: 'Test' })
  } finally {
    cleanup()
  }
})

test('shows the stored facts and notes but leaves out captured tool calls', () => {
  const { dir, run, cleanup } = setupHookRun()
  try {
    const context = startedWith(run('context.mjs', startOf(dir), '', searchResults(
      hit('tool-1', 'Tool: Bash\nInput: {"command":"npm test"}'),
      hit('fact-1', 'The project keeps one memory per fact.'),
      hit('note-1', 'Response: The build passed.'),
    )))
    assert.match(context, /^Relevant memory from ai-center:/)
    assert.match(context, /- The project keeps one memory per fact\./)
    assert.match(context, /- Response: The build passed\./)
    assert.ok(!context.includes('Tool: Bash'))
  } finally {
    cleanup()
  }
})

test('trims a long memory to one short line', () => {
  const { dir, run, cleanup } = setupHookRun()
  try {
    const context = startedWith(run('context.mjs', startOf(dir), '', searchResults(hit('long-1', `Line one\n${'x'.repeat(2000)}`))))
    const [, line] = context.split('\n')
    assert.ok(line.length < 400, `line has ${line.length} characters`)
    assert.ok(line.endsWith('…'))
    assert.equal(context.split('\n').length, 2)
  } finally {
    cleanup()
  }
})

test('caches the memory_add content limit that the backend advertises', () => {
  const { dir, run, projectCache, cleanup } = setupHookRun()
  try {
    run('context.mjs', startOf(dir), '', { FAKE_ADD_LIMIT: '5000' })
    assert.equal(projectCache().projectId, 42)
    assert.equal(projectCache().addContentMaxChars, 5000)
  } finally {
    cleanup()
  }
})

test('still starts the session when the content limit cannot be read', () => {
  const { dir, run, toolCalls, projectCache, cleanup } = setupHookRun()
  try {
    run('context.mjs', startOf(dir), 'tools-list-error')
    assert.equal(projectCache().projectId, 42)
    assert.equal(projectCache().addContentMaxChars, undefined)
    assert.ok(toolCalls().some((call) => call.name === 'memory_search'))
  } finally {
    cleanup()
  }
})

test('says no memory was found when nothing or only tool calls come back', () => {
  const { dir, run, cleanup } = setupHookRun()
  try {
    const empty = startedWith(run('context.mjs', startOf(dir), '', searchResults()))
    const onlyTools = startedWith(run('context.mjs', startOf(dir), '', searchResults(hit('tool-1', 'Tool: Read\nInput: {}'))))
    assert.equal(empty, 'ai-center: no prior memory found for this project yet.')
    assert.equal(onlyTools, empty)
  } finally {
    cleanup()
  }
})
