import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTurn } from '../scripts/lib/note/turn-transcript.mjs'

const CLAUDE = 'claude-code'
const CODEX = 'codex-mcp-client'

function withTranscript(entries, run) {
	const dir = mkdtempSync(join(tmpdir(), 'ai-center-transcript-test-'))
	try {
		const path = join(dir, 'transcript.jsonl')
		writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join('\n'))
		return run(path)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

const user = (content, extra = {}) => ({ type: 'user', promptId: 'p1', message: { role: 'user', content }, ...extra })
const assistant = (...blocks) => ({ type: 'assistant', message: { role: 'assistant', content: blocks } })
const toolUse = (name, input = {}) => ({ type: 'tool_use', id: `id-${name}`, name, input })
const text = (value) => ({ type: 'text', text: value })

const codexMessage = (role, value) => ({
	type: 'response_item',
	payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text: value }] },
})
const codexCall = (type, name) => ({ type: 'response_item', payload: { type, name } })

test('lists the skills the model invoked and the tools it used, in first-use order', () => {
	const entries = [
		user('please do it'),
		assistant(toolUse('Read'), toolUse('Skill', { skill: 'ecc:tdd-workflow' }), toolUse('Bash'), toolUse('Read')),
		assistant(text('done')),
	]
	const turn = withTranscript(entries, (path) => readTurn(path, 'p1', CLAUDE))
	assert.deepEqual(turn.skills, ['ecc:tdd-workflow'])
	assert.deepEqual(turn.tools, ['Read', 'Bash'])
})

test('turns a skill slash command into the prompt and counts it as a skill used', () => {
	const command =
		'<command-message>ecc:deep-research</command-message> <command-name>/ecc:deep-research</command-name> ' +
		'<command-args>how to cache</command-args>'
	const entries = [
		user(command),
		user([text('Base directory for this skill: /x/skills/deep-research\n# Deep research')], { isMeta: true }),
		assistant(text('researching')),
	]
	const turn = withTranscript(entries, (path) => readTurn(path, 'p1', CLAUDE))
	assert.equal(turn.prompt, '/ecc:deep-research how to cache')
	assert.deepEqual(turn.skills, ['ecc:deep-research'])
})

test('a built-in command is neither a prompt nor a skill', () => {
	const entries = [
		user('<command-name>/resume</command-name> <command-message>resume</command-message> <command-args></command-args>'),
		user('<local-command-stdout>resumed</local-command-stdout>'),
	]
	assert.equal(withTranscript(entries, (path) => readTurn(path, 'p1', CLAUDE)), undefined)
})

test('Codex tool calls give the tool names and no skills', () => {
	const entries = [
		codexMessage('user', 'run it'),
		codexCall('custom_tool_call', 'exec'),
		codexCall('function_call', 'wait'),
		codexMessage('assistant', 'done'),
	]
	const turn = withTranscript(entries, (path) => readTurn(path, undefined, CODEX))
	assert.deepEqual(turn.tools, ['exec', 'wait'])
	assert.deepEqual(turn.skills, [])
})

test('an environment_context message after the prompt is not taken as the prompt', () => {
	const entries = [
		codexMessage('user', 'the real prompt'),
		codexMessage('user', '<environment_context>\n<cwd>/work</cwd>\n</environment_context>'),
		codexMessage('assistant', 'done'),
	]
	const turn = withTranscript(entries, (path) => readTurn(path, undefined, CODEX))
	assert.equal(turn.prompt, 'the real prompt')
})

test('a Claude prompt started by print mode or the SDK is marked programmatic', () => {
	const turnOf = (entrypoint) =>
		withTranscript([user('summarize', { entrypoint }), assistant(text('ok'))], (path) => readTurn(path, 'p1', CLAUDE))
	assert.equal(turnOf('sdk-cli').programmatic, true)
	assert.equal(turnOf('cli').programmatic, false)
})

test('a Codex session started by codex exec is marked programmatic', () => {
	const header = (source, originator) => ({ type: 'session_meta', payload: { source, originator } })
	const turnOf = (first) =>
		withTranscript([first, codexMessage('user', 'run it'), codexMessage('assistant', 'done')], (path) =>
			readTurn(path, undefined, CODEX))
	assert.equal(turnOf(header('exec', 'codex_exec')).programmatic, true)
	assert.equal(turnOf(header('vscode', 'codex-tui')).programmatic, false)
})

test('a Claude run never looks at the Codex header of the file', () => {
	const entries = [
		{ type: 'session_meta', payload: { source: 'exec', originator: 'codex_exec' } },
		user('hello', { entrypoint: 'cli' }),
		assistant(text('hi')),
	]
	assert.equal(withTranscript(entries, (path) => readTurn(path, 'p1', CLAUDE)).programmatic, false)
})

test('an unknown platform still checks the Codex header', () => {
	const entries = [
		{ type: 'session_meta', payload: { source: 'exec', originator: 'codex_exec' } },
		codexMessage('user', 'run it'),
		codexMessage('assistant', 'done'),
	]
	assert.equal(withTranscript(entries, (path) => readTurn(path, undefined, undefined)).programmatic, true)
})

// A turn can hold several prompts: every prompt and all the thinking belong to the note.
const step = (stopReason, ...blocks) => ({
	type: 'assistant',
	message: { role: 'assistant', stop_reason: stopReason, content: blocks },
})
const thought = (value) => ({ type: 'thinking', thinking: value })

test('Claude: a follow-up typed mid-turn joins the turn, with all prompts and all thinking', () => {
	const entries = [
		user('fix the login bug'),
		step('tool_use', thought('plan the fix'), toolUse('Read')),
		user('also add a test', { promptId: 'p2', promptSource: 'queued' }),
		step('end_turn', thought('now the test'), text('done')),
	]
	const turn = withTranscript(entries, (path) => readTurn(path, 'p2', CLAUDE))
	assert.deepEqual(turn.prompts, ['fix the login bug', 'also add a test'])
	assert.deepEqual(turn.thinking, ['plan the fix', 'now the test'])
})

test('Claude: a turn that already ended is not pulled into the next one', () => {
	const entries = [
		user('first question'),
		step('end_turn', thought('first thoughts'), text('first answer')),
		user('second question', { promptId: 'p2' }),
		step('end_turn', thought('second thoughts'), text('second answer')),
	]
	const turn = withTranscript(entries, (path) => readTurn(path, 'p2', CLAUDE))
	assert.deepEqual(turn.prompts, ['second question'])
	assert.deepEqual(turn.thinking, ['second thoughts'])
})

test('Claude: an interrupt marker is not a prompt, and the interrupted prompt is kept', () => {
	const entries = [
		user('start the big job'),
		step('tool_use', thought('working'), toolUse('Bash')),
		user([text('[Request interrupted by user for tool use]')]),
		user('do it differently', { promptId: 'p2' }),
		step('end_turn', thought('another way'), text('ok')),
	]
	const turn = withTranscript(entries, (path) => readTurn(path, 'p2', CLAUDE))
	assert.deepEqual(turn.prompts, ['start the big job', 'do it differently'])
	assert.deepEqual(turn.thinking, ['working', 'another way'])
})

const codexIn = (turnId, payload) => ({
	type: 'response_item',
	payload: { ...payload, internal_chat_message_metadata_passthrough: { turn_id: turnId } },
})
const codexSaid = (turnId, role, value) =>
	codexIn(turnId, {
		type: 'message',
		role,
		content: [{ type: role === 'user' ? 'input_text' : 'output_text', text: value }],
	})
const codexThought = (turnId, value) =>
	codexIn(turnId, { type: 'reasoning', summary: [{ type: 'summary_text', text: value }] })

test('Codex: messages that share a turn id are one turn, with all prompts and all thinking', () => {
	const entries = [
		codexSaid('t1', 'user', 'first request'),
		codexThought('t1', 'plan'),
		codexSaid('t1', 'user', 'also this'),
		codexThought('t1', 'more'),
		codexSaid('t1', 'assistant', 'done'),
	]
	const turn = withTranscript(entries, (path) => readTurn(path, undefined, CODEX))
	assert.deepEqual(turn.prompts, ['first request', 'also this'])
	assert.deepEqual(turn.thinking, ['plan', 'more'])
})

test('Codex: an earlier turn with another turn id is not pulled in', () => {
	const entries = [
		codexSaid('t0', 'user', 'old request'),
		codexThought('t0', 'old thought'),
		codexSaid('t0', 'assistant', 'old answer'),
		codexSaid('t1', 'user', 'new request'),
		codexThought('t1', 'new thought'),
		codexSaid('t1', 'assistant', 'new answer'),
	]
	const turn = withTranscript(entries, (path) => readTurn(path, undefined, CODEX))
	assert.deepEqual(turn.prompts, ['new request'])
	assert.deepEqual(turn.thinking, ['new thought'])
})

// MCP tools are listed apart from the other tools. Codex reports an MCP call as an event, not as a tool call.
test('Claude: MCP tools are listed apart from the other tools, each once', () => {
	const entries = [
		user('look it up'),
		assistant(
			toolUse('Read'),
			toolUse('mcp__ai-center__memory_search'),
			toolUse('mcp__mcp_server_mysql__mysql_query'),
			toolUse('mcp__ai-center__memory_search'),
		),
		assistant(text('done')),
	]
	const turn = withTranscript(entries, (path) => readTurn(path, 'p1', CLAUDE))
	assert.deepEqual(turn.tools, ['Read'])
	assert.deepEqual(turn.mcp, ['mcp__ai-center__memory_search', 'mcp__mcp_server_mysql__mysql_query'])
})

const codexMcpCall = (turnId, server, tool, status = 'completed') => ({
	type: 'event_msg',
	payload: { type: 'item_completed', turn_id: turnId, item: { type: 'McpToolCall', server, tool, status } },
})

test('Codex: an MCP call event is listed as an MCP tool, and only for its own turn', () => {
	const entries = [
		codexSaid('t0', 'user', 'old request'),
		codexMcpCall('t0', 'ai-center', 'memory_add'),
		codexSaid('t0', 'assistant', 'old answer'),
		codexSaid('t1', 'user', 'search it'),
		codexIn('t1', { type: 'custom_tool_call', name: 'exec' }),
		codexMcpCall('t1', 'ai-center', 'memory_search'),
		codexMcpCall('t1', 'ai-center', 'memory_search', 'failed'),
		codexMcpCall('t1', 'mysql', 'query'),
		codexSaid('t1', 'assistant', 'done'),
	]
	const turn = withTranscript(entries, (path) => readTurn(path, undefined, CODEX))
	assert.deepEqual(turn.tools, ['exec'])
	assert.deepEqual(turn.mcp, ['mcp__ai-center__memory_search', 'mcp__mysql__query'])
})

test('Codex: an exec call that reads a skills/<name>/SKILL.md counts that skill as used', () => {
	const read = 'text(await tools.exec_command({cmd:"cat /home/u/.codex/skills/.system/openai-docs/SKILL.md"}))'
	// A SKILL.md outside a skills folder, and a file listing, are not a skill being used.
	const other = 'text(await tools.exec_command({cmd:"cat /home/u/work/notes/SKILL.md; rg --files -g \'*/SKILL.md\'"}))'
	const entries = [
		codexSaid('t1', 'user', 'use the docs skill'),
		codexIn('t1', { type: 'custom_tool_call', name: 'exec', input: other }),
		codexIn('t1', { type: 'custom_tool_call', name: 'exec', input: read }),
		codexSaid('t1', 'assistant', 'done'),
	]
	const turn = withTranscript(entries, (path) => readTurn(path, undefined, CODEX))
	assert.deepEqual(turn.skills, ['openai-docs'])
	assert.deepEqual(turn.tools, ['exec'])
})
