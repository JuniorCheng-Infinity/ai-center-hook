import { randomBytes } from 'node:crypto'
import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

// Plumbing every hook script needs: reading stdin, small JSON files and file ranges, and running a hook.
// None of it knows how ai-center is reached. The one exception is the variable below, which lives here
// because runHook reads it and the summarizer, which sets it, already imports this file.

// Set on the model run that the hooks start themselves, so that run's own hooks know to stay out of it.
export const SUMMARY_RUN_ENV = 'AI_CENTER_HOOKS_SUMMARY_RUN'

let hookInput = {}

// The stdin payload of this run, as already read by readStdinJson.
export function getHookInput() {
	return hookInput
}

export async function readStdinJson() {
	hookInput = await parseStdinJson()
	return hookInput
}

// Returns undefined when the text is not JSON.
export function parseJson(text) {
	try {
		return JSON.parse(text)
	} catch {
		return undefined
	}
}

export function errorMessage(error) {
	return String(error?.message ?? error)
}

// A recoverable problem leaves one quiet line on stderr and the hook goes on.
export function logWarning(label, error) {
	process.stderr.write(`${label} (${errorMessage(error)})\n`)
}

// A missing file is routine and silent; any other problem is logged. Both give the fallback.
export function readJsonFile(path, fallback, label) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'))
	} catch (error) {
		if (error?.code !== 'ENOENT') logWarning(label, error)
		return fallback
	}
}

// The file is replaced in one step, so a reader never sees half of it.
export function writeJsonFile(path, value, label) {
	const tmpPath = `${path}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`
	try {
		mkdirSync(dirname(path), { recursive: true })
		writeFileSync(tmpPath, JSON.stringify(value))
		renameSync(tmpPath, path)
	} catch (error) {
		rmSync(tmpPath, { force: true })
		logWarning(label, error)
	}
}

async function parseStdinJson() {
	if (process.stdin.isTTY) return {}
	const chunks = []
	for await (const chunk of process.stdin) chunks.push(chunk)
	const raw = Buffer.concat(chunks).toString('utf8').trim()
	if (!raw) return {}
	return parseJson(raw) ?? {}
}

// A hook failure must never block the user's session, so it is reported and the exit code is always 0.
export async function runHook(fn, onFailure) {
	// A model run that the hooks started themselves must not fire the hooks again.
	if (process.env[SUMMARY_RUN_ENV]) process.exit(0)
	try {
		await fn()
	} catch (error) {
		onFailure(error)
	}
	process.exit(0)
}

// The two directory signals every hook needs, resolved once, in one place.
// cwd: live, follows the agent (Claude Code passes it in stdin; Codex too).
// projectDir: CLAUDE_PROJECT_DIR if set (Claude Code only — stays fixed to
// wherever the session launched, survives cd and worktrees); falls back to
// cwd on platforms with no such env var (Codex has none, per its own hook
// docs — only PLUGIN_ROOT/PLUGIN_DATA, no launch-directory constant).
export function resolveDirs(input) {
	const cwd = input.cwd ?? process.cwd()
	const projectDir = process.env.CLAUDE_PROJECT_DIR ?? cwd
	return { cwd, projectDir }
}

// Reads the bytes [start, start + length) of a file. Only what was really read becomes text, so a short read
// can never leave zero characters behind.
function readRange(path, start, length) {
	const fd = openSync(path, 'r')
	try {
		const buffer = Buffer.alloc(length)
		const bytesRead = readSync(fd, buffer, 0, length, start)
		return buffer.toString('utf8', 0, bytesRead)
	} finally {
		closeSync(fd)
	}
}

// The first maxBytes of a file, or all of it when it is smaller.
export function readHead(path, maxBytes) {
	return readRange(path, 0, Math.min(statSync(path).size, maxBytes))
}

// The last maxBytes of a file, or all of it when it is smaller.
export function readTail(path, maxBytes) {
	const { size } = statSync(path)
	const start = Math.max(0, size - maxBytes)
	return readRange(path, start, size - start)
}
