// How the turn-note hook finds the earlier note of the same work: the text it searches with, and which hit it may
// update. This file reads nothing from disk.

// The search text is cut here. The cut is only for the search; the request monitor keeps the exact text that was sent.
export const LOOKUP_QUERY_MAX_CHARS = 2_000

// A turn note starts with a label memory-handler.mjs writes: "User prompt: ", "User prompt:\n" or
// "User prompt (summary): ". A fact the AI wrote, an old tool capture and a document chunk do not, so none of them is
// ever replaced by a turn note.
const TURN_NOTE_START = /^User prompt( \(summary\))?:/

// The prompt and the reply say what the work is about; the thinking is long and would only add noise.
export function lookupQuery({ prompt = '', response = '' } = {}) {
	return [prompt.trim(), response.trim()].filter(Boolean).join('\n\n').slice(0, LOOKUP_QUERY_MAX_CHARS)
}

function isTurnNote(hit) {
	return typeof hit?.id === 'string' && typeof hit.memory === 'string' && TURN_NOTE_START.test(hit.memory)
}

// Hits come ranked by similarity, but the order is not trusted. The most similar turn note wins; a chunk has no memory.
// Only a note this hook wrote itself may be replaced, so ownNoteIds is the set of ids it wrote. That keeps another
// user's notes, and a note the AI changed since, out of reach, and it needs no lookup of who the user is.
export function chooseNoteToUpdate(hits, ownNoteIds) {
	if (!Array.isArray(hits) || !(ownNoteIds instanceof Set)) return undefined
	return hits
		.filter((hit) => isTurnNote(hit) && ownNoteIds.has(hit.id))
		.sort((a, b) => (Number(b.similarity) || 0) - (Number(a.similarity) || 0))[0]
}
