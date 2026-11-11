// Keyed by connection and never trusted for authorization, because the server checks every call.
// Cache I/O failures are logged. Lock failures reject the save so it cannot run without protection.

import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { logWarning, readJsonFile, writeJsonFile } from '../hook-utils.mjs'

export const CACHE_DIR = join(homedir(), '.cache', 'ai-center-hooks')
const MAX_TURN_NOTES = 200
const TURN_NOTE_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000
// As long as one save request, so a waiting save outlasts a normal save.
const LOCK_WAIT_MS = 8_000
const LOCK_RETRY_MS = 50
// Longer than the slowest save (an update that fails with 404 and falls back to an add), so a live lock is never taken.
const LOCK_STALE_MS = 20_000

function getCachePath(connection) {
	const key = createHash('sha256').update(`${connection.baseUrl}|${connection.apiKey}`).digest('hex')
	return join(CACHE_DIR, `${key}.json`)
}

// The one place the connection's file is read and every field is checked, so a damaged file reads as empty fields.
function readConnectionCache(connection) {
	const data = readJsonFile(getCachePath(connection), undefined, 'cache failed to read')
	const { projectId, addContentMaxChars } = data ?? {}
	return {
		projectId: typeof projectId === 'number' ? projectId : undefined,
		addContentMaxChars:
			Number.isInteger(addContentMaxChars) && addContentMaxChars > 0 ? addContentMaxChars : undefined,
	}
}

export function readProjectCache(connection) {
	return readConnectionCache(connection).projectId
}

export function readAddContentLimit(connection) {
	return readConnectionCache(connection).addContentMaxChars
}

// The backend's document_add content limit rides along with the project id, so one SessionStart refreshes both.
export function writeProjectCache(connection, projectId, addContentMaxChars) {
	writeJsonFile(getCachePath(connection), { projectId, addContentMaxChars }, 'cache failed to write')
}

export function clearProjectCache(connection) {
	try {
		rmSync(getCachePath(connection), { force: true })
	} catch (error) {
		logWarning('cache failed to clear', error)
	}
}

// Undefined without a session identity: the turn then has no saved note id and no lock.
// Legacy unscoped turn-notes.json is deliberately not read.
export function buildTurnNoteScope(connection, projectId, platform, input, transcriptPath) {
	const session = input.session_id || transcriptPath
	if (!session) return undefined
	return createHash('sha256').update(JSON.stringify([
		connection.baseUrl, connection.apiKey, projectId, platform ?? 'unknown', session,
	])).digest('hex')
}

function getTurnNotesPath(scope) {
	return join(CACHE_DIR, `turn-notes-${scope}.json`)
}

function processIsAlive(pid) {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return error.code === 'EPERM'
	}
}

// The lock is a file that only one process can create, and it holds its owner's process id. A lock whose owner has
// died is taken over at once; one older than LOCK_STALE_MS is taken over whatever it says, which also covers a reused
// id. Two waiters taking over the same abandoned lock at the same instant may both save, costing one duplicate note.
function lockIsAbandoned(lockPath) {
	try {
		const owner = Number.parseInt(readFileSync(lockPath, 'utf8'), 10)
		if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) return true
		return Number.isInteger(owner) && !processIsAlive(owner)
	} catch {
		return false
	}
}

async function acquireTurnNoteLock(lockPath) {
	const deadline = Date.now() + LOCK_WAIT_MS
	for (;;) {
		try {
			const fd = openSync(lockPath, 'wx', 0o600)
			try {
				writeSync(fd, String(process.pid))
			} finally {
				closeSync(fd)
			}
			return
		} catch (error) {
			if (error.code !== 'EEXIST') throw new Error(`Cannot acquire turn-note lock: ${error.message}`)
		}
		if (lockIsAbandoned(lockPath)) rmSync(lockPath, { force: true })
		else if (Date.now() >= deadline) throw new Error('Timed out waiting for the turn-note save lock')
		else await delay(LOCK_RETRY_MS)
	}
}

// Only this process's own lock is removed: a save that outlived LOCK_STALE_MS may find another process holding it.
function releaseTurnNoteLock(lockPath) {
	try {
		if (readFileSync(lockPath, 'utf8') === String(process.pid)) rmSync(lockPath, { force: true })
	} catch (error) {
		if (error.code !== 'ENOENT') logWarning('cache failed to release the turn-note lock', error)
	}
}

export async function withTurnNoteLock(scope, save) {
	const lockPath = `${getTurnNotesPath(scope)}.lock`
	mkdirSync(CACHE_DIR, { recursive: true })
	await acquireTurnNoteLock(lockPath)
	try {
		return await save()
	} finally {
		releaseTurnNoteLock(lockPath)
	}
}

export function readTurnNoteIds(scope) {
	const ids = readJsonFile(getTurnNotesPath(scope), {}, 'cache failed to read turn notes')
	return typeof ids === 'object' && ids !== null && !Array.isArray(ids)
		? Object.fromEntries(Object.entries(ids).filter(([, id]) => typeof id === 'string' && id.length > 0))
		: {}
}

// Only the most recent turns are kept.
export function writeTurnNoteId(scope, turnId, memoryId) {
	const recent = Object.entries({ ...readTurnNoteIds(scope), [turnId]: memoryId }).slice(-MAX_TURN_NOTES)
	writeJsonFile(getTurnNotesPath(scope), Object.fromEntries(recent), 'cache failed to write turn notes')
}

// A session rewrites its file every turn, so a file untouched for a day belongs to a session that is over.
export function pruneTurnNoteFiles() {
	try {
		const cutoff = Date.now() - TURN_NOTE_FILE_MAX_AGE_MS
		for (const name of readdirSync(CACHE_DIR)) {
			const path = join(CACHE_DIR, name)
			if (name.startsWith('turn-notes') && statSync(path).mtimeMs < cutoff) rmSync(path, { force: true })
		}
	} catch (error) {
		if (error.code !== 'ENOENT') logWarning('cache failed to prune turn notes', error)
	}
}
