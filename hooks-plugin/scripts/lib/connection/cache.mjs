// Keyed by connection and never trusted for authorization, because the server checks every call.
// A cache problem must never crash a hook, so every function here logs it and carries on.

import { createHash } from 'node:crypto'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { logWarning, readJsonFile, writeJsonFile } from '../hook-utils.mjs'

export const CACHE_DIR = join(homedir(), '.cache', 'ai-center-hooks')
const TURN_NOTES_PATH = join(CACHE_DIR, 'turn-notes.json')
const MAX_TURN_NOTES = 200

function cachePathFor(connection) {
	const key = createHash('sha256').update(`${connection.baseUrl}|${connection.apiKey}`).digest('hex')
	return join(CACHE_DIR, `${key}.json`)
}

// The one place the connection's file is read and every field is checked, so a damaged file reads as empty fields.
function readConnectionCache(connection) {
	const data = readJsonFile(cachePathFor(connection), undefined, 'cache failed to read')
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

// The backend's memory_add content limit rides along with the project id, so one SessionStart refreshes both.
export function writeProjectCache(connection, projectId, addContentMaxChars) {
	writeJsonFile(cachePathFor(connection), { projectId, addContentMaxChars }, 'cache failed to write')
}

export function clearProjectCache(connection) {
	try {
		rmSync(cachePathFor(connection), { force: true })
	} catch (error) {
		logWarning('cache failed to clear', error)
	}
}

export function readTurnNoteIds() {
	const ids = readJsonFile(TURN_NOTES_PATH, {}, 'cache failed to read turn notes')
	return typeof ids === 'object' && ids !== null ? ids : {}
}

// Only the most recent turns are kept.
export function writeTurnNoteId(turnId, memoryId) {
	const recent = Object.entries({ ...readTurnNoteIds(), [turnId]: memoryId }).slice(-MAX_TURN_NOTES)
	writeJsonFile(TURN_NOTES_PATH, Object.fromEntries(recent), 'cache failed to write turn notes')
}
