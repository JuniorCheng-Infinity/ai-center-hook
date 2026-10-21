// Shortens one text to a character budget by asking a model CLI once. Nothing is cut silently: when the CLI
// fails or its answer is still too long, SummaryError is thrown and the caller reports it.
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM } from '../connection/client-connections.mjs'
import { SUMMARY_RUN_ENV } from '../hook-utils.mjs'

// Models overshoot a limit, and 6 of 6 summaries fit when asked for 60% of the budget.
const FIRST_ASK = 0.6
const CALL_TIMEOUT_MS = 100_000
// A summary is a few thousand characters, so a program that prints far more than this has gone wrong.
const MAX_OUTPUT_CHARS = 1_000_000

export class SummaryError extends Error {
	constructor(message) {
		super(message)
		this.name = 'SummaryError'
	}
}

function buildPrompt(text, limit) {
	return [
		`Rewrite the text below as a shorter version of at most ${limit} characters.`,
		'',
		'Rules:',
		'- Remove repetition, filler, politeness and step-by-step narration.',
		'- Keep every decision, conclusion, result, file path, command, identifier, number, name and unresolved question.',
		'- Use plain, direct sentences. Keep the original language.',
		'- Do not add anything that is not in the text.',
		'- Output only the shortened text, with no preamble and no closing remark.',
		'',
		'Text:',
		'<<<',
		text,
		'>>>',
	].join('\n')
}

// One command per platform. Codex writes only its final message to a file, so the answer is not mixed with progress.
function buildCommand(platform, workDir) {
	if (platform === PLATFORM.claudeCode) return { file: 'claude', args: ['--model', 'haiku', '-p'] }
	if (platform === PLATFORM.codex) {
		const outFile = join(workDir, 'summary.txt')
		const args = [
			'exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '--ignore-user-config',
			'--disable', 'hooks', '-C', workDir, '-o', outFile, '-',
		]
		return { file: 'codex', args, outFile }
	}
	throw new SummaryError(`no summarizer for platform ${platform ?? 'unknown'}`)
}

// Runs one program with the input on stdin and answers { status, stdout, error }. It never rejects: a program
// that cannot start, runs too long, or prints too much is stopped and described in error.
export function runCommand(file, args, { input, env, timeoutMs, maxOutputChars = MAX_OUTPUT_CHARS }) {
	return new Promise((resolve) => {
		const child = spawn(file, args, { env, stdio: ['pipe', 'pipe', 'ignore'] })
		let stdout = ''
		let stoppedBecause
		const stop = (reason) => {
			stoppedBecause ??= reason
			child.kill('SIGKILL')
		}
		const timer = setTimeout(() => stop(`timed out after ${timeoutMs / 1000}s`), timeoutMs)

		// Decoding as it arrives keeps a character that is split between two chunks whole.
		child.stdout.setEncoding('utf8')
		child.stdout.on('data', (chunk) => {
			stdout += chunk
			if (stdout.length > maxOutputChars) stop(`the model run printed more than ${maxOutputChars} characters`)
		})
		child.on('error', (error) => {
			clearTimeout(timer)
			resolve({ status: null, stdout, error: error.message })
		})
		child.on('close', (status) => {
			clearTimeout(timer)
			resolve({ status, stdout, error: stoppedBecause })
		})
		// The child may exit before it has read everything.
		child.stdin.on('error', () => {})
		child.stdin.end(input)
	})
}

function readAnswer(outFile, stdout) {
	if (!outFile) return stdout.trim()
	try {
		return readFileSync(outFile, 'utf8').trim()
	} catch {
		throw new SummaryError('the model run wrote no summary file')
	}
}

export async function contentSummarizer(text, { budget, platform, run = runCommand }) {
	// Only codex writes its answer to a file, so only a codex run gets a folder for it.
	const workDir = platform === PLATFORM.codex ? mkdtempSync(join(tmpdir(), 'ai-center-summary-')) : undefined
	try {
		const { file, args, outFile } = buildCommand(platform, workDir)
		const env = { ...process.env, [SUMMARY_RUN_ENV]: '1' }
		// A nested claude may refuse to start while this is set; ECC clears it the same way.
		delete env.CLAUDECODE

		const input = buildPrompt(text, Math.floor(budget * FIRST_ASK))
		const result = await run(file, args, { input, env, timeoutMs: CALL_TIMEOUT_MS })
		if (result.error) throw new SummaryError(result.error)
		if (result.status !== 0) throw new SummaryError(`${file} exited with ${result.status}`)

		const summary = readAnswer(outFile, result.stdout)
		if (!summary) throw new SummaryError('the summary was empty')
		if (summary.length > budget) {
			throw new SummaryError(`the summary is ${summary.length} chars, over the ${budget} budget`)
		}
		return summary
	} finally {
		if (workDir) rmSync(workDir, { recursive: true, force: true })
	}
}
