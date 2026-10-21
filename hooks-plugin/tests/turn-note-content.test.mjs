import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setupHookRun } from './fake-ai-center.mjs'

const user = (content) => ({ type: 'user', promptId: 'turn-1', message: { role: 'user', content } })
const assistant = (...blocks) => ({ type: 'assistant', message: { role: 'assistant', content: blocks } })
const toolUse = (name, input = {}) => ({ type: 'tool_use', id: `id-${name}`, name, input })

// Runs the real Stop hook against a transcript on disk, with the fake server answering.
function stopWith(dir, entries, reply, promptId = 'turn-1') {
	const transcript = join(dir, 'transcript.jsonl')
	writeFileSync(transcript, entries.map((entry) => JSON.stringify(entry)).join('\n'))
	return {
		cwd: dir,
		hook_event_name: 'Stop',
		prompt_id: promptId,
		transcript_path: transcript,
		last_assistant_message: reply,
	}
}

// A stand-in for the claude program: it records the guard variable and answers or fails as told.
function fakeClaude(dir, { exitCode = 0, answer = 'FAKE SUMMARY' } = {}) {
	const bin = join(dir, 'bin')
	mkdirSync(bin, { recursive: true })
	const guardFile = join(dir, 'guard.txt')
	const script = `#!/bin/sh\ncat > /dev/null\necho "$AI_CENTER_HOOKS_SUMMARY_RUN" > "${guardFile}"\n` +
		(exitCode === 0 ? `echo "${answer}"\n` : `exit ${exitCode}\n`)
	writeFileSync(join(bin, 'claude'), script)
	chmodSync(join(bin, 'claude'), 0o755)
	return { PATH: `${bin}:${process.env.PATH}`, CLAUDECODE: '1', guardFile }
}

const addedContent = (toolCalls) => toolCalls.filter((call) => call.name === 'memory_add').map((call) => call.arguments.content)

// The usage text of every memory_add, read from the _meta of its request; undefined when the call carried none.
const usageSent = (requests) =>
	requests
		.filter((request) => request.method === 'tools/call' && request.params.name === 'memory_add')
		.map((request) => request.params._meta?.['ai-center/usage'])

test('a normal turn saves the text as typed, and its tools and skills travel in _meta, not in the note', () => {
	const { dir, run, toolCalls, sentRequests, cleanup } = setupHookRun()
	try {
		const entries = [
			user('please use /ecc:tdd-workflow now'),
			{
				type: 'assistant',
				message: {
					role: 'assistant',
					content: [
						{ type: 'thinking', thinking: 'plan it' },
						toolUse('Read'),
						toolUse('Skill', { skill: 'ecc:tdd-workflow' }),
					],
				},
			},
		]
		run('turn-note.mjs', stopWith(dir, entries, 'Done'), '', { CLAUDECODE: '1' })
		assert.deepEqual(addedContent(toolCalls()), [
			'User prompt: please use /ecc:tdd-workflow now\n\nThinking:\nplan it\n\nResponse: Done',
		])
		assert.deepEqual(usageSent(sentRequests()), ['tool: Read\nskill: ecc:tdd-workflow'])
	} finally {
		cleanup()
	}
})

test('a follow-up typed mid-turn is saved as a numbered list, with the thinking of both parts', () => {
	const { dir, run, toolCalls, cleanup } = setupHookRun()
	try {
		const step = (stopReason, ...blocks) => ({
			type: 'assistant',
			message: { role: 'assistant', stop_reason: stopReason, content: blocks },
		})
		const entries = [
			user('fix the login bug'),
			step('tool_use', { type: 'thinking', thinking: 'plan the fix' }, toolUse('Read')),
			{ ...user('also add a test'), promptId: 'turn-2', promptSource: 'queued' },
			step('end_turn', { type: 'thinking', thinking: 'now the test' }, { type: 'text', text: 'done' }),
		]
		// Whichever of the two prompt ids the hook is given, the whole turn is saved.
		run('turn-note.mjs', stopWith(dir, entries, 'Done', 'turn-2'), '', { CLAUDECODE: '1' })
		assert.deepEqual(addedContent(toolCalls()), [
			'User prompt:\n1. fix the login bug\n2. also add a test\n\n' +
				'Thinking:\nplan the fix\n\nnow the test\n\nResponse: Done',
		])
	} finally {
		cleanup()
	}
})

test('a turn whose thinking is too long is saved without it, and still sends its tools', () => {
	const { dir, run, toolCalls, sentRequests, cleanup } = setupHookRun()
	try {
		const entries = [user('question'), assistant({ type: 'thinking', thinking: 'x'.repeat(12000) }, toolUse('Read'))]
		run('turn-note.mjs', stopWith(dir, entries, 'Answer'), '', { CLAUDECODE: '1' })
		const [content] = addedContent(toolCalls())
		assert.equal(content, 'User prompt: question\n\nResponse: Answer')
		assert.deepEqual(usageSent(sentRequests()), ['tool: Read'])
	} finally {
		cleanup()
	}
})

test('a turn that used tools but had no thinking still sends them in _meta, not in the note', () => {
	const { dir, run, toolCalls, sentRequests, cleanup } = setupHookRun()
	try {
		const entries = [
			user('question'),
			assistant(toolUse('Bash'), toolUse('mcp__ai-center__memory_search'), toolUse('Bash')),
		]
		run('turn-note.mjs', stopWith(dir, entries, 'Answer'), '', { CLAUDECODE: '1' })
		assert.deepEqual(addedContent(toolCalls()), ['User prompt: question\n\nResponse: Answer'])
		assert.deepEqual(usageSent(sentRequests()), ['tool: Bash\nmcp: mcp__ai-center__memory_search'])
	} finally {
		cleanup()
	}
})

test('a turn that used no tool and no skill sends no usage', () => {
	const { dir, run, sentRequests, cleanup } = setupHookRun()
	try {
		const entries = [user('question'), assistant({ type: 'text', text: 'hi' })]
		run('turn-note.mjs', stopWith(dir, entries, 'Answer'), '', { CLAUDECODE: '1' })
		assert.deepEqual(usageSent(sentRequests()), [undefined])
	} finally {
		cleanup()
	}
})

test('a turn whose response is too long is saved with a summary of the response', () => {
	const { dir, run, toolCalls, cleanup } = setupHookRun()
	try {
		const extraEnv = fakeClaude(dir)
		const entries = [user('short question'), assistant({ type: 'text', text: 'ignored here' })]
		run('turn-note.mjs', stopWith(dir, entries, 'r'.repeat(12000)), '', extraEnv)
		assert.deepEqual(addedContent(toolCalls()), [
			'User prompt: short question\n\nResponse (summary): FAKE SUMMARY',
		])
		assert.equal(readFileSync(extraEnv.guardFile, 'utf8').trim(), '1')
	} finally {
		cleanup()
	}
})

test('a failed summary saves nothing and is reported', () => {
	const { dir, run, toolCalls, failures, message, cleanup } = setupHookRun()
	try {
		const extraEnv = fakeClaude(dir, { exitCode: 1 })
		const entries = [user('short question'), assistant({ type: 'text', text: 'ignored here' })]
		const result = run('turn-note.mjs', stopWith(dir, entries, 'r'.repeat(12000)), '', extraEnv)
		assert.deepEqual(addedContent(toolCalls()), [])
		assert.match(failures().at(-1).info, /claude exited with 1/)
		assert.match(message(result), /^ai-center memory: turn-note failed - claude exited with 1$/)
	} finally {
		cleanup()
	}
})
