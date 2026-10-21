import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { writeFakeFetch } from './fake-ai-center.mjs'

const root = resolve('hooks-plugin')

test('configured Stop command captures Codex and Claude payloads', () => {
	const dir = mkdtempSync(join(tmpdir(), 'ai-center-hooks-test-'))
	try {
		const calls = join(dir, 'calls.jsonl')
		const preload = writeFakeFetch(dir)
		const config = JSON.parse(readFileSync(join(root, 'hooks/hooks.json')))
		const env = { ...process.env, CLAUDE_PLUGIN_ROOT: root, AI_CENTER_BASE_URL: 'http://test.invalid',
			AI_CENTER_API_KEY: 'test-key', TEST_CALLS: calls, NODE_OPTIONS: `--import=${preload}` }
		delete env.CLAUDECODE
		delete env.PLUGIN_ROOT
		function run(event, input) {
			const handler = config.hooks[event][0].hooks[0]
			assert.equal(handler.args, undefined)
			const result = spawnSync(handler.command, { shell: true, input: JSON.stringify(input), env, encoding: 'utf8' })
			assert.equal(result.error, undefined)
			assert.equal(result.status, 0)
			assert.equal(result.stderr, '')
			return readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse)
				.filter((call) => call.params?.name === 'memory_add').at(-1).params.arguments
		}
		for (const platform of ['codex', 'claude']) {
			const transcript = join(dir, platform + '.jsonl')
			const entry = platform === 'codex'
				? {
					type: 'response_item',
					payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the hook' }] },
				}
				: { type: 'user', message: { content: [{ type: 'text', text: 'Fix the hook' }] } }
			writeFileSync(transcript, JSON.stringify(entry) + '\n')
			const turn = run('Stop', { cwd: dir, transcript_path: transcript, last_assistant_message: 'Fixed it' })
			assert.equal(turn.project_id, 42)
			assert.match(turn.content, /User prompt: Fix the hook/)
			assert.match(turn.content, /Response: Fixed it/)
		}
		assert.equal(config.hooks.Stop[0].hooks[0].async, undefined)
		// Exercise connection discovery without the explicit hook environment.
		const codexHome = join(dir, 'config.toml')
		writeFileSync(
			codexHome,
			'[mcp_servers.ai-center]\nurl = "http://test.invalid/mcp"\n' +
				'[mcp_servers.ai-center.http_headers]\nAuthorization = "Bearer codex-test-key"\n',
		)
		delete env.AI_CENTER_BASE_URL
		delete env.AI_CENTER_API_KEY
		// Unset so the test runner's own CLAUDECODE (this suite can run inside a
		// real Claude Code session) doesn't leak in and make detectPlatform()
		// skip the Codex discovery path this block is actually exercising.
		delete env.CLAUDECODE
		env.CODEX_HOME = dir
		const discovered = run('Stop', {
			cwd: dir, transcript_path: join(dir, 'claude.jsonl'), last_assistant_message: 'config discovered',
		})
		assert.match(discovered.content, /Response: config discovered/)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

// The block stays in hooks.json so it can be switched on again, but its matcher matches no tool name.
test('hooks.json keeps the per-tool capture switched off', () => {
	const config = JSON.parse(readFileSync(join(root, 'hooks/hooks.json')))
	const entries = config.hooks.PostToolUse ?? []
	assert.ok(entries.length > 0, 'the PostToolUse block should stay in hooks.json')
	for (const entry of entries) assert.equal(entry.matcher, '__disabled__')
})

test('tool-observer.mjs, kept but switched off, still records one tool call when run directly', () => {
	const dir = mkdtempSync(join(tmpdir(), 'ai-center-hooks-test-'))
	try {
		const calls = join(dir, 'calls.jsonl')
		const preload = writeFakeFetch(dir)
		const env = { ...process.env, CLAUDE_PLUGIN_ROOT: root, AI_CENTER_BASE_URL: 'http://test.invalid',
			AI_CENTER_API_KEY: 'test-key', TEST_CALLS: calls, NODE_OPTIONS: `--import=${preload}` }
		delete env.CLAUDECODE
		delete env.PLUGIN_ROOT
		function observe(input) {
			const script = join(root, 'scripts/tool-observer.mjs')
			const result = spawnSync('node', [script], { input: JSON.stringify(input), env, encoding: 'utf8' })
			assert.equal(result.error, undefined)
			assert.equal(result.status, 0)
			assert.equal(result.stderr, '')
			return readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse)
				.filter((call) => call.params?.name === 'memory_add').at(-1).params.arguments
		}
		const tool = observe({ cwd: dir, tool_name: 'Bash', tool_input: { command: 'echo ok' }, tool_response: 'ok' })
		assert.equal(tool.project_id, 42)
		assert.match(tool.content, /echo ok/)
		assert.match(tool.content, /Result: ok/)
		const missing = observe({ cwd: dir, tool_name: 'Bash' })
		assert.match(missing.content, /Input: null/)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test('tool-observer.mjs, kept but switched off, does not capture calls to ai-center\'s memory tools', () => {
	const dir = mkdtempSync(join(tmpdir(), 'ai-center-hooks-test-'))
	try {
		const calls = join(dir, 'calls.jsonl')
		const preload = writeFakeFetch(dir)
		const env = { ...process.env, CLAUDE_PLUGIN_ROOT: root, AI_CENTER_BASE_URL: 'http://test.invalid',
			AI_CENTER_API_KEY: 'test-key', TEST_CALLS: calls, NODE_OPTIONS: `--import=${preload}` }
		// The script is run by its path, because its matcher in hooks.json is switched off.
		const handler = { command: `node "${join(root, 'scripts/tool-observer.mjs')}"` }
		// Claude Code spells the server name with a hyphen, Codex with an underscore.
		const aiCenterTools = ['mcp__ai-center__memory_add', 'mcp__ai-center__memory_search',
			'mcp__ai_center__memory_add', 'mcp__ai_center__memory_search']
		for (const tool of aiCenterTools) {
			const input = { cwd: dir, tool_name: tool, tool_input: { query: 'x' }, tool_response: 'y' }
			const result = spawnSync(handler.command, { shell: true, input: JSON.stringify(input), env, encoding: 'utf8' })
			assert.equal(result.error, undefined)
			assert.equal(result.status, 0)
			assert.equal(result.stderr, '')
		}
		// A skipped call makes no network request, so the calls file may not exist.
		const recorded = existsSync(calls)
			? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
			: []
		assert.equal(recorded.filter((call) => call.params?.name === 'memory_add').length, 0)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

// Shared setup for the Stop-hook tests: a temp dir, a fake network that records
// every request, and `stop(entries, reply)` which runs the Stop hook against a
// transcript made of `entries` and returns only the memory_add arguments of that run.
function setupStopRun(platform) {
	const dir = mkdtempSync(join(tmpdir(), 'ai-center-hooks-test-'))
	const calls = join(dir, 'calls.jsonl')
	const preload = writeFakeFetch(dir)
	const config = JSON.parse(readFileSync(join(root, 'hooks/hooks.json')))
	// HOME is the throwaway folder, so no turn id of a test reaches the real cache.
	const env = { ...process.env, HOME: dir, CLAUDE_PLUGIN_ROOT: root, AI_CENTER_BASE_URL: 'http://test.invalid',
		AI_CENTER_API_KEY: 'test-key', TEST_CALLS: calls, NODE_OPTIONS: `--import=${preload}` }
	delete env.CLAUDECODE
	delete env.PLUGIN_ROOT
	if (platform === 'claude') env.CLAUDECODE = '1'
	if (platform === 'codex') env.PLUGIN_ROOT = '/fake/.codex/plugins/cache/ai-center'
	function stop(entries, reply = 'Done', extraInput = {}) {
		const transcript = join(dir, 'transcript.jsonl')
		writeFileSync(transcript, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
		rmSync(calls, { force: true })
		const handler = config.hooks.Stop[0].hooks[0]
		const input = { cwd: dir, transcript_path: transcript, last_assistant_message: reply, ...extraInput }
		const result = spawnSync(handler.command, { shell: true, input: JSON.stringify(input), env, encoding: 'utf8' })
		assert.equal(result.error, undefined)
		assert.equal(result.status, 0)
		assert.equal(result.stderr, '')
		// A skipped hook makes no network request, so the calls file may not exist.
		if (!existsSync(calls)) return []
		return readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
			.filter((call) => call.params?.name === 'memory_add').map((call) => call.params.arguments)
	}
	// The _meta of every memory_add the last Stop sent.
	const sentMeta = () => {
		if (!existsSync(calls)) return []
		return readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
			.filter((call) => call.params?.name === 'memory_add').map((call) => call.params._meta)
	}
	return { stop, sentMeta, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// Transcript entries as the two clients really write them. The Codex shapes were
// checked against real rollout files (an event_msg McpToolCall for each MCP call).
const claudeUser = (text) => ({ type: 'user', message: { content: [{ type: 'text', text }] } })
const claudeToolUse = (name) =>
	({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name, input: {} }] } })
const claudeToolResult = (text = 'ok') =>
	({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: text }] } })
const codexUser = (text) =>
	({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
// Claude Code writes the turn id on every user entry, and extra marks an entry the system injected.
const claudeUserOf = (promptId, text, extra = {}) =>
	({ type: 'user', promptId, message: { content: [{ type: 'text', text }] }, ...extra })
const claudeThinking = (thinking) =>
	({ type: 'assistant', message: { content: [{ type: 'thinking', thinking }] } })
const codexMcpCall = (tool) => ({ type: 'event_msg', payload: { type: 'item_completed',
	item: { type: 'McpToolCall', server: 'ai-center', tool, status: 'completed' } } })

test('Stop logs every turn, including turns where the agent wrote to memory', () => {
	const { stop, cleanup } = setupStopRun()
	try {
		for (const tool of ['memory_add', 'memory_update']) {
			const turns = {
				claude: [claudeUser('Record this fact'), claudeToolUse(`mcp__ai-center__${tool}`), claudeToolResult()],
				codex: [codexUser('Record this fact'), codexMcpCall(tool)],
			}
			for (const [platform, entries] of Object.entries(turns)) {
				const [note] = stop(entries)
				assert.ok(note, `${platform} ${tool}: no note was saved`)
				assert.match(note.content, /User prompt: Record this fact/, `${platform} ${tool}`)
				assert.match(note.content, /Response: Done/, `${platform} ${tool}`)
			}
		}
	} finally {
		cleanup()
	}
})

test('Stop still logs turns that only searched memory or used other tools', () => {
	const { stop, cleanup } = setupStopRun()
	try {
		const turns = [
			[claudeUser('Find the fact'), claudeToolUse('mcp__ai-center__memory_search'), claudeToolResult()],
			[claudeUser('Find the fact'), claudeToolUse('Bash'), claudeToolResult()],
			[codexUser('Find the fact'), codexMcpCall('memory_search')],
		]
		for (const entries of turns) {
			const [note] = stop(entries)
			assert.match(note.content, /User prompt: Find the fact/)
			assert.match(note.content, /Response: Done/)
		}
	} finally {
		cleanup()
	}
})

test('Stop still saves the prompt when the turn is longer than the first read window', () => {
	const { stop, cleanup } = setupStopRun()
	try {
		// 300 KB of tool output, more than the 200 KB the hook first reads from the end.
		const bigResult = claudeToolResult('x'.repeat(300_000))
		const [note] = stop([claudeUser('Run the tests'), claudeToolUse('Bash'), bigResult])
		assert.match(note.content, /User prompt: Run the tests/)
	} finally {
		cleanup()
	}
})

test('Stop saves the typed prompt when an injected entry with the same prompt id follows it', () => {
	const { stop, cleanup } = setupStopRun()
	try {
		const entries = [
			claudeUserOf('p1', 'Fix the hook'),
			claudeUserOf('p1', 'Injected context', { isMeta: true }),
			claudeThinking('Looking at the hook'),
		]
		const [note] = stop(entries, 'Done', { prompt_id: 'p1' })
		assert.match(note.content, /User prompt: Fix the hook/)
		assert.doesNotMatch(note.content, /Injected context/)
		assert.match(note.content, /Looking at the hook/)
	} finally {
		cleanup()
	}
})

test('Stop uses the latest prompt when no message carries the turn id', () => {
	const { stop, cleanup } = setupStopRun()
	try {
		const [codexNote] = stop([codexUser('Earlier question'), codexUser('Current question')], 'Done', { turn_id: 't1' })
		assert.match(codexNote.content, /User prompt: Current question/)

		const claude = [claudeUser('Earlier question'), claudeUser('Current question')]
		const [claudeNote] = stop(claude, 'Done', { prompt_id: 'not-in-the-log' })
		assert.match(claudeNote.content, /User prompt: Current question/)
	} finally {
		cleanup()
	}
})

test('Stop uses only the prompt and thinking of its own turn when the log holds two turns', () => {
	const { stop, cleanup } = setupStopRun()
	try {
		const entries = [
			claudeUserOf('pA', 'Question A'),
			claudeThinking('Thought A'),
			claudeUserOf('pB', 'Question B'),
			claudeThinking('Thought B'),
		]
		const [note] = stop(entries, 'Done', { prompt_id: 'pB' })
		assert.match(note.content, /User prompt: Question B/)
		assert.match(note.content, /Thought B/)
		assert.doesNotMatch(note.content, /Question A|Thought A/)
	} finally {
		cleanup()
	}
})

const codexReasoning = (summary) => ({ type: 'response_item', payload: { type: 'reasoning', summary } })
const summaryText = (text) => ({ type: 'summary_text', text })

test('Stop captures Codex summaries once, in order, for only the latest turn', () => {
	for (const platform of ['codex', undefined]) {
		const { stop, cleanup } = setupStopRun(platform)
		try {
			const entries = [
				codexUser('Earlier question'),
				codexReasoning([summaryText('Earlier summary')]),
				codexUser('Current question'),
				codexReasoning([summaryText('First summary'), summaryText('Second summary')]),
				{ type: 'event_msg', payload: { type: 'agent_reasoning', text: 'First summary' } },
				codexReasoning([summaryText('Third summary')]),
			]
			const [note] = stop(entries)
			assert.equal(note.content, 'User prompt: Current question\n\nThinking:\nFirst summary\n\nSecond summary\n\nThird summary\n\nResponse: Done')
		} finally {
			cleanup()
		}
	}
})

test('Stop omits missing, empty and malformed Codex summaries', () => {
	const { stop, cleanup } = setupStopRun('codex')
	try {
		for (const summary of [undefined, null, {}, [], [null, summaryText('  '), summaryText(42), { type: 'text', text: 'ignored' }]]) {
			const [note] = stop([codexUser('Current question'), codexReasoning(summary)])
			assert.equal(note.content, 'User prompt: Current question\n\nResponse: Done')
		}
	} finally {
		cleanup()
	}
})

test('Stop uses the detected client format and ignores the other format', () => {
	for (const platform of ['claude', 'codex']) {
		const { stop, cleanup } = setupStopRun(platform)
		try {
			const entries = [
				claudeUser('Claude question'), claudeThinking('Claude thinking'),
				codexUser('Codex question'), codexReasoning([summaryText('Codex summary')]),
			]
			const [note] = stop(entries)
			assert.equal(note.content, platform === 'claude'
				? 'User prompt: Claude question\n\nThinking:\nClaude thinking\n\nResponse: Done'
				: 'User prompt: Codex question\n\nThinking:\nCodex summary\n\nResponse: Done')
		} finally {
			cleanup()
		}
	}
})

test('Stop does not include thinking after the next genuine Claude prompt', () => {
	const { stop, cleanup } = setupStopRun('claude')
	try {
		const [note] = stop([
			claudeUserOf('pA', 'Question A'),
			claudeUserOf('pA', 'Injected context', { isMeta: true }),
			claudeThinking('Thought A'),
			claudeUserOf('pB', 'Question B'),
			claudeThinking('Thought B'),
		], 'Done', { prompt_id: 'pA' })
		assert.equal(note.content, 'User prompt: Question A\n\nThinking:\nThought A\n\nResponse: Done')
	} finally {
		cleanup()
	}
})

test('Stop sends the tools and MCP tools of a Codex turn in _meta and keeps them out of the note', () => {
	const { stop, sentMeta, cleanup } = setupStopRun('codex')
	try {
		const exec = { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'text("ls")' } }
		const [note] = stop([codexUser('Search the memory'), exec, codexMcpCall('memory_search')])
		assert.equal(note.content, 'User prompt: Search the memory\n\nResponse: Done')
		assert.equal(sentMeta().at(-1)['ai-center/usage'], 'tool: exec\nmcp: mcp__ai-center__memory_search')
	} finally {
		cleanup()
	}
})
