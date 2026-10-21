// Reports hook failures to the user and keeps a record shaped like request_log_tbl.
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { AiCenterError } from './ai-center-mcp.mjs'
import { CACHE_DIR } from './cache.mjs'
import { errorMessage, getHookInput, readJsonFile, runHook, writeJsonFile } from '../hook-utils.mjs'

const FAILURE_LOG = join(CACHE_DIR, 'failures.jsonl')
const SUMMARY_CURSOR = join(CACHE_DIR, 'failures-summary.json')
// Only these events show a systemMessage on screen (checked in Claude Code, documented for Codex).
const VISIBLE_EVENTS = new Set(['UserPromptSubmit', 'Stop'])
const REPEAT_WINDOW_MS = 60_000
const MAX_LOG_BYTES = 100_000
const KEPT_LOG_ENTRIES = 200

function describe(failure) {
	const head = [failure.operation, failure.status_code ? `HTTP ${failure.status_code}` : undefined]
		.filter(Boolean)
		.join(' ')
	if (!head) return failure.info
	return failure.status_code ? `${head}, ${failure.info}` : `${head} ${failure.info}`
}

function buildFailure(error) {
	const known = error instanceof AiCenterError
	return {
		created_datetime: new Date().toISOString(),
		hook: basename(process.argv[1] ?? 'hook', '.mjs'),
		operation: known ? error.operation : null,
		endpoint: known ? error.endpoint : null,
		method: known ? error.method : null,
		status_code: known ? error.statusCode : null,
		latency_ms: known ? error.latencyMs : null,
		request_id: known ? error.requestId : null,
		info: errorMessage(error),
	}
}

function readFailures() {
	try {
		return readFileSync(FAILURE_LOG, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
	} catch {
		return []
	}
}

function appendFailure(failure) {
	mkdirSync(CACHE_DIR, { recursive: true })
	appendFileSync(FAILURE_LOG, `${JSON.stringify(failure)}\n`)
	if (statSync(FAILURE_LOG).size <= MAX_LOG_BYTES) return
	const kept = readFailures().slice(-KEPT_LOG_ENTRIES)
	writeFileSync(FAILURE_LOG, kept.map((entry) => `${JSON.stringify(entry)}\n`).join(''))
}

function isRepeat(failure, earlier) {
	return earlier.some((entry) =>
		entry.display === 'now' &&
		entry.hook === failure.hook &&
		entry.operation === failure.operation &&
		entry.status_code === failure.status_code &&
		entry.info === failure.info &&
		Date.now() - Date.parse(entry.created_datetime) < REPEAT_WINDOW_MS)
}

// Shows the failure now when this event can show it, otherwise leaves it for the next prompt's summary.
export function reportFailure(error) {
	try {
		const failure = buildFailure(error)
		const canShow = VISIBLE_EVENTS.has(getHookInput().hook_event_name)
		failure.display = !canShow ? 'pending' : isRepeat(failure, readFailures()) ? 'suppressed' : 'now'
		appendFailure(failure)
		process.stderr.write(`ai-center hook error: ${describe(failure)}\n`)
		if (failure.display === 'now') {
			process.stdout.write(
				JSON.stringify({ systemMessage: `ai-center memory: ${failure.hook} failed - ${describe(failure)}` }),
			)
		}
	} catch (loggingError) {
		process.stderr.write(
			`ai-center hook error: ${errorMessage(error)} (failure log: ${errorMessage(loggingError)})\n`,
		)
	}
}

// How every hook script runs its work: a failure is reported the same way each time and never blocks the session.
export function runAiCenterHook(work) {
	return runHook(work, reportFailure)
}

function readSummaryCursor() {
	return readJsonFile(SUMMARY_CURSOR, undefined, 'failure summary cursor failed to read')?.shown_until ?? ''
}

// One line about failures that could not be shown when they happened, each reported only once.
export function takePendingSummary() {
	const shownUntil = readSummaryCursor()
	const pending = readFailures().filter((entry) => entry.display === 'pending' && entry.created_datetime > shownUntil)
	if (pending.length === 0) return undefined

	writeJsonFile(SUMMARY_CURSOR, { shown_until: new Date().toISOString() }, 'failure summary cursor failed to write')

	const perHook = new Map()
	for (const entry of pending) perHook.set(entry.hook, (perHook.get(entry.hook) ?? 0) + 1)
	const hooks = [...perHook].map(([hook, count]) => `${hook} x${count}`).join(', ')
	const noun = pending.length === 1 ? 'failure' : 'failures'
	return (
		`ai-center memory: ${pending.length} hook ${noun} since your last prompt (${hooks}), ` +
		`last: ${describe(pending.at(-1))}`
	)
}
