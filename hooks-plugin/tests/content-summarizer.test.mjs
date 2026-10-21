import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contentSummarizer, runCommand, SummaryError } from '../scripts/lib/note/content-summarizer.mjs'
import { SUMMARY_RUN_ENV } from '../scripts/lib/hook-utils.mjs'

const CLAUDE = 'claude-code'
const CODEX = 'codex-mcp-client'

// A fake run records what it was asked to start and answers the way a CLI would.
function fakeRun(reply = { status: 0, stdout: 'short text' }) {
	const calls = []
	const run = async (file, args, options) => {
		calls.push({ file, args, ...options })
		if (reply.writeOutFile !== undefined) writeFileSync(args[args.indexOf('-o') + 1], reply.writeOutFile)
		return reply
	}
	return { run, calls }
}

const rejectsWith = (promise, pattern) =>
	assert.rejects(promise, (error) => error instanceof SummaryError && pattern.test(error.message))

test('asks claude -p for the summary, text on stdin, guard variable set, CLAUDECODE removed', async () => {
	const { run, calls } = fakeRun({ status: 0, stdout: '  short text \n' })
	process.env.CLAUDECODE = '1'
	try {
		const summary = await contentSummarizer('x'.repeat(500), { budget: 100, platform: CLAUDE, run })
		assert.equal(summary, 'short text')
	} finally {
		delete process.env.CLAUDECODE
	}
	assert.equal(calls[0].file, 'claude')
	assert.deepEqual(calls[0].args, ['--model', 'haiku', '-p'])
	assert.equal(calls[0].env[SUMMARY_RUN_ENV], '1')
	assert.equal('CLAUDECODE' in calls[0].env, false)
	assert.match(calls[0].input, /^Rewrite the text below/)
	assert.ok(calls[0].input.includes('x'.repeat(500)))
})

test('asks for 60% of the budget, because models overshoot a limit', async () => {
	const { run, calls } = fakeRun()
	await contentSummarizer('some long text', { budget: 1000, platform: CLAUDE, run })
	assert.match(calls[0].input, /at most 600 characters/)
})

test('asks codex exec with hooks disabled and reads the answer from the output file', async () => {
	const { run, calls } = fakeRun({ status: 0, stdout: '', writeOutFile: ' codex summary \n' })
	const summary = await contentSummarizer('some long text', { budget: 100, platform: CODEX, run })
	assert.equal(summary, 'codex summary')
	assert.equal(calls[0].file, 'codex')
	for (const flag of ['exec', '--ephemeral', '--ignore-user-config', '--disable', 'hooks', '-o']) {
		assert.ok(calls[0].args.includes(flag), `missing ${flag}`)
	}
	assert.equal(calls[0].args.at(-1), '-')
	assert.equal(calls[0].env[SUMMARY_RUN_ENV], '1')
})

test('rejects a summary that is still over the budget', async () => {
	const { run } = fakeRun({ status: 0, stdout: 'y'.repeat(101) })
	await rejectsWith(contentSummarizer('text', { budget: 100, platform: CLAUDE, run }), /over the 100 budget/)
})

test('rejects an empty summary', async () => {
	const { run } = fakeRun({ status: 0, stdout: '  \n' })
	await rejectsWith(contentSummarizer('text', { budget: 100, platform: CLAUDE, run }), /empty/)
})

test('rejects when the command exits with an error', async () => {
	const { run } = fakeRun({ status: 1, stdout: '' })
	await rejectsWith(contentSummarizer('text', { budget: 100, platform: CLAUDE, run }), /exited with 1/)
})

test('rejects when the command times out or cannot start', async () => {
	const { run } = fakeRun({ status: null, stdout: '', error: 'timed out after 100s' })
	await rejectsWith(contentSummarizer('text', { budget: 100, platform: CLAUDE, run }), /timed out after 100s/)
})

test('rejects an unknown platform without starting anything', async () => {
	const { run, calls } = fakeRun()
	await rejectsWith(contentSummarizer('text', { budget: 100, platform: undefined, run }), /no summarizer for platform unknown/)
	assert.equal(calls.length, 0)
})

// The summarizer makes its temporary folder under the system temp folder, which these tests point at their own.
async function withOwnTmp(run) {
	const own = mkdtempSync(join(tmpdir(), 'ai-center-tmp-test-'))
	const saved = process.env.TMPDIR
	process.env.TMPDIR = own
	try {
		await run(own)
	} finally {
		if (saved === undefined) delete process.env.TMPDIR
		else process.env.TMPDIR = saved
		rmSync(own, { recursive: true, force: true })
	}
}

test('a claude run creates no temporary folder, because only codex needs one', async () => {
	await withOwnTmp(async (own) => {
		let during
		const run = async () => {
			during = readdirSync(own)
			return { status: 0, stdout: 'short text' }
		}
		await contentSummarizer('text', { budget: 100, platform: CLAUDE, run })
		assert.deepEqual(during, [])
		assert.deepEqual(readdirSync(own), [])
	})
})

test('a codex run has its temporary folder while it runs and none afterwards', async () => {
	await withOwnTmp(async (own) => {
		let during
		const run = async (file, args) => {
			during = readdirSync(own)
			writeFileSync(args[args.indexOf('-o') + 1], 'codex summary')
			return { status: 0, stdout: '' }
		}
		await contentSummarizer('text', { budget: 100, platform: CODEX, run })
		assert.equal(during.length, 1)
		assert.deepEqual(readdirSync(own), [])
	})
})

test('a failed codex run leaves no temporary folder behind either', async () => {
	await withOwnTmp(async (own) => {
		const run = async () => ({ status: 1, stdout: '' })
		await rejectsWith(contentSummarizer('text', { budget: 100, platform: CODEX, run }), /exited with 1/)
		assert.deepEqual(readdirSync(own), [])
	})
})

const node = (script, options = {}) =>
	runCommand(process.execPath, ['-e', script], { input: '', env: process.env, timeoutMs: 10_000, ...options })

test('runCommand collects what the program prints and its exit code', async () => {
	const result = await node(`process.stdout.write('hello')`)
	assert.deepEqual(result, { status: 0, stdout: 'hello', error: undefined })
})

test('runCommand sends the input on stdin', async () => {
	const result = await node('process.stdin.pipe(process.stdout)', { input: 'ping' })
	assert.equal(result.stdout, 'ping')
})

test('runCommand stops a program that prints more than the cap', async () => {
	const script = `setInterval(() => process.stdout.write('x'.repeat(100)), 5)`
	const result = await node(script, { maxOutputChars: 500 })
	assert.match(result.error, /more than 500 characters/)
})

test('runCommand stops a program that runs longer than its time limit', async () => {
	const result = await node('setTimeout(() => {}, 10000)', { timeoutMs: 200 })
	assert.match(result.error, /timed out after 0.2s/)
})

test('runCommand reports a program that cannot start', async () => {
	const result = await runCommand('no-such-program-ai-center', [], { input: '', env: process.env, timeoutMs: 5000 })
	assert.equal(result.status, null)
	assert.ok(result.error)
})
