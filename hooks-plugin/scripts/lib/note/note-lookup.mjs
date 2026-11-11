// How the turn-note hook finds the earlier note of the same work: the text it searches with, and which hit it may
// update. This file reads nothing from disk.
import { isConversationLog } from './memory-handler.mjs'

// The search text is cut here. The cut is only for the search; the request monitor keeps the exact text that was sent.
export const LOOKUP_QUERY_MAX_CHARS = 2_000

// The prompt and the reply say what the work is about; the thinking is long and would only add noise.
export function buildLookupQuery({ prompt = '', response = '' } = {}) {
	return [prompt.trim(), response.trim()].filter(Boolean).join('\n\n').slice(0, LOOKUP_QUERY_MAX_CHARS)
}

// The search covers the whole project, and the backend has already dropped every hit under the configured threshold,
// so the most similar hit that comes from an earlier turn note wins, whether it is a memory or a chunk. Its source
// document is what gets updated. A fact the AI wrote, an old tool capture and any other document are never replaced.
export function chooseNoteToUpdate(hits) {
	if (!Array.isArray(hits)) return undefined
	return hits
		.filter((hit) => typeof hit?.id === 'string' && isTurnNoteDocument(hit.included?.document))
		.sort((a, b) => (Number(b.similarity) || 0) - (Number(a.similarity) || 0))[0]
}

// A turn note is a document whose title starts like the note the hook writes.
function isTurnNoteDocument(document) {
	return typeof document?.id === 'string' && typeof document.title === 'string' && isConversationLog(document.title)
}

// Hits came back, but none names its source document: search.include.documents is off, so nothing can be updated.
export function hasNoSourceDocuments(hits) {
	return Array.isArray(hits) && hits.length > 0 && hits.every((hit) => typeof hit?.included?.document?.id !== 'string')
}
