import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { CACHE_DIR, createFileOnce, pruneCacheFiles } from '../connection/cache.mjs'

// Checks shared by every kind of notice.

// Characters that can move the cursor, recolor the screen or add lines.
const CONTROL_CHARACTER = /[\p{Cc}\p{Zl}\p{Zp}]/u

export const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

// A non-empty text within the limit and without control characters, or undefined.
export function readSafeText(value, limit) {
	if (typeof value !== 'string' || value.length === 0 || value.length > limit) return undefined
	return CONTROL_CHARACTER.test(value) ? undefined : value
}

// A marker file only records that a notice was shown and decides nothing else.
const MARKER_PREFIX = 'notice-'
// A marker older than this belongs to a session that is over, so it is removed.
const MARKER_MAX_AGE_MS = 24 * 60 * 60 * 1000

// True for the first run of a notice kind in a session and start source, and always without a session id.
export function claimNotice({ kind, input }) {
	if (!input.session_id) return true
	const key = createHash('sha256').update(JSON.stringify([kind, input.session_id, input.source ?? ''])).digest('hex')
	mkdirSync(CACHE_DIR, { recursive: true })
	pruneCacheFiles(MARKER_PREFIX, MARKER_MAX_AGE_MS)
	return createFileOnce(join(CACHE_DIR, `${MARKER_PREFIX}${key}`))
}
