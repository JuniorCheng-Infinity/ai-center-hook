// Classifies recalled memories, chooses what recall shows and drops repeated ones.
// Composes turn notes within the backend limit and reads them.

export function isRecallableMemory(hit) {
	return typeof hit?.id === 'string' && typeof hit.memory === 'string' && !hit.memory.startsWith('Tool:')
}

export function isConversationLog(text) {
	return /^(?:User prompt|Thinking|Response)(?: \(summary\))?:/.test(text)
}

// The most entries recall shows for one prompt.
const MAX_RECALL_ENTRIES = 3

const newestFirst = (a, b) => b.updatedAt.localeCompare(a.updatedAt)
const isChunk = (hit) => typeof hit?.id === 'string' && typeof hit.chunk === 'string' && typeof hit.memory !== 'string'
const memoryKind = (hit) => (isConversationLog(hit.memory) ? 'log' : 'fact')

function buildRecallEntry(kind, hit) {
	const document = hit.included?.document
	return {
		kind,
		id: kind === 'passage' ? null : hit.id,
		documentId: document?.id ?? null,
		title: document?.title ?? null,
		updatedAt: String(hit.system?.updatedAt ?? ''),
		text: kind === 'passage' ? hit.chunk : hit.memory,
		similarity: Number(hit.similarity) || 0,
	}
}

function bestPerDocument(entries) {
	const best = new Map()
	for (const entry of entries) {
		const key = entry.documentId ?? `memory:${entry.id}`
		if (!best.has(key) || entry.similarity > best.get(key).similarity) best.set(key, entry)
	}
	return [...best.values()].sort((a, b) => b.similarity - a.similarity)
}

function memoryEntries(hits) {
	const entries = hits.filter(isRecallableMemory).map((hit) => buildRecallEntry(memoryKind(hit), hit))
	return bestPerDocument(entries)
}

function passageEntries(hits, shownDocuments) {
	const entries = hits
		.filter((hit) => isChunk(hit) && hit.included?.document?.id && !hit.chunk.startsWith('Tool:'))
		.map((hit) => buildRecallEntry('passage', hit))
		.filter((entry) => !shownDocuments.has(entry.documentId))
	return bestPerDocument(entries)
}

// Memories first, then passages in the free slots, shown newest first.
// The similarity threshold is the backend's own (supermemory-config.jsonc): every hit it sent has already passed it.
export function selectRecallEntries(hits) {
	const memories = memoryEntries(hits).slice(0, MAX_RECALL_ENTRIES)
	const shown = new Set(memories.map((entry) => entry.documentId))
	const passages = passageEntries(hits, shown).slice(0, MAX_RECALL_ENTRIES - memories.length)
	return [...memories, ...passages].sort(newestFirst)
}

// Finds the hits recall cannot use and says why, one sentence for each kind.
export function badHitsDetection(hits) {
	const unreadable = hits.filter((hit) => typeof hit?.id !== 'string').length
	const withoutDocument = hits.filter((hit) => isChunk(hit) && !hit.included?.document?.id).length
	return [
		unreadable && `search hits that cannot be read skipped: ${unreadable}`,
		withoutDocument && `chunk hits without a source document skipped: ${withoutDocument} (is include.documents on?)`,
	].filter(Boolean)
}

// Two entries say the same thing when at least this share of their words is shared (shared / all different words).
const WORD_OVERLAP_LIMIT = 0.6
// An entry is judged to be inside a longer one when at least this share of its words is in the longer one.
const CONTAINMENT_LIMIT = 0.8
// A shorter entry needs at least this many words to be judged this way, so a very short one is never swallowed.
const MIN_CONTAINED_WORDS = 4
const LEADING_DATE = /^\[[^\]]*\]\s*/

// Lower case, without a leading [date], cut into words at every character that is not a letter or a digit.
function splitIntoWords(text) {
	return text.toLowerCase().replace(LEADING_DATE, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

function wordOverlap(first, second) {
	const shared = [...first].filter((word) => second.has(word)).length
	return shared / (first.size + second.size - shared)
}

// 3 for a prohibition, 2 for a requirement, 1 for anything softer.
function strengthOf(text) {
	if (/\b(?:forbids?|prohibits?|never|must not)\b/i.test(text)) return 3
	if (/\b(?:requires?|must|always)\b/i.test(text)) return 2
	return 1
}

// What share of the shorter entry's words is in the longer one.
function wordContainment(shorter, longer) {
	const shared = [...shorter].filter((word) => longer.has(word)).length
	return shared / shorter.size
}

const isTheSame = (other, candidate) =>
	(typeof candidate.id === 'string' && other.id === candidate.id) ||
	other.plain === candidate.plain ||
	wordOverlap(other.distinct, candidate.distinct) >= WORD_OVERLAP_LIMIT

// The shorter entry is inside the longer one when most of its words are there, unless it is the stronger of the two,
// so that a prohibition is never dropped for a softer sentence.
function isInside(other, candidate) {
	const [shorter, longer] = other.distinct.size <= candidate.distinct.size ? [other, candidate] : [candidate, other]
	return shorter.distinct.size >= MIN_CONTAINED_WORDS &&
		wordContainment(shorter.distinct, longer.distinct) >= CONTAINMENT_LIMIT &&
		strengthOf(shorter.memory) <= strengthOf(longer.memory)
}

// Entries that say the same thing give way to the stronger wording; an entry inside a longer one gives way to it.
function replaces(candidate, other) {
	if (isTheSame(other, candidate)) return strengthOf(candidate.memory) > strengthOf(other.memory)
	return candidate.distinct.size > other.distinct.size
}

// Keeps the first of the entries that say the same thing, in order, unless a later one says it more strongly.
// An entry that is inside a longer one gives way to it.
// Every entry must have text: the caller checks and reports the ones that have not.
export function dropRepeatedEntries(entries) {
	const kept = []

	for (const entry of entries) {
		const words = splitIntoWords(entry.memory)
		const distinct = new Set(words.filter((word) => word.length > 2))
		const candidate = { ...entry, plain: words.join(' '), distinct }
		const at = kept.findIndex((other) => isTheSame(other, candidate) || isInside(other, candidate))

		if (at === -1) kept.push(candidate)
		else if (replaces(candidate, kept[at])) kept[at] = candidate
	}

	return kept.map(({ id, memory }) => ({ id, memory }))
}

// Used only when the backend's limit cannot be read (the backend's own default for document_add).
export const DEFAULT_ADD_CONTENT_MAX_CHARS = 10_000

const SEPARATOR = '\n\n'
const LABELS = {
	prompt: 'User prompt: ',
	thinking: 'Thinking:\n',
	response: 'Response: ',
	promptSummary: 'User prompt (summary): ',
	responseSummary: 'Response (summary): ',
}

// A field is plain text, or { summary } for text that was shortened, which gets the "(summary)" label.
// A field that starts on a new line (a list of prompts) takes the label without its trailing space.
function addLabel(field, label, summaryLabel) {
	if (typeof field !== 'string') return summaryLabel + field.summary
	return (field.startsWith('\n') ? label.trimEnd() : label) + field
}

// The one place that joins the sections, so the length counted and the text sent can never drift apart.
function compose({ prompt, thinking, response }) {
	const parts = []

	if (prompt) parts.push(addLabel(prompt, LABELS.prompt, LABELS.promptSummary))
	if (thinking) parts.push(LABELS.thinking + thinking)
	if (response) parts.push(addLabel(response, LABELS.response, LABELS.responseSummary))

	return parts.join(SEPARATOR)
}

const PROMPT_LABELS = [LABELS.promptSummary, LABELS.prompt].map((label) => label.trimEnd())
const THINKING_MARKER = SEPARATOR + LABELS.thinking
const RESPONSE_MARKERS = [LABELS.response, LABELS.responseSummary].map((label) => SEPARATOR + label.trimEnd())

// The earliest of the markers in the text, or null when none is there.
function findFirstMarker(text, markers) {
	const found = markers.map((marker) => ({ marker, at: text.indexOf(marker) })).filter(({ at }) => at !== -1)
	return found.length ? found.reduce((first, next) => (next.at < first.at ? next : first)) : null
}

// Takes a note apart again, the opposite of compose. Text that is not a turn note gives null.
export function readTurnNote(content) {
	if (typeof content !== 'string') return null

	const label = PROMPT_LABELS.find((candidate) => content.startsWith(candidate))
	if (!label) return null

	const body = content.slice(label.length)
	const response = findFirstMarker(body, RESPONSE_MARKERS)
	const promptEnd = findFirstMarker(body, [THINKING_MARKER, ...RESPONSE_MARKERS])?.at ?? body.length

	return {
		prompt: body.slice(0, promptEnd).trim(),
		response: response ? body.slice(response.at + response.marker.length).trim() : '',
	}
}

// The last question of a reply and everything after it, or the last paragraph when it asks nothing or when that
// block is longer than the limit, as when an early question only quotes the user.
export function findClosingBlock(response, limit = Infinity) {
	const paragraphs = response.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean)
	const lastQuestion = paragraphs.findLastIndex((paragraph) => paragraph.includes('?'))
	const block = paragraphs.slice(lastQuestion === -1 ? -1 : lastQuestion).join(SEPARATOR)

	return block.length > limit ? paragraphs.at(-1) : block
}

// A limit that cannot even hold the labels would ask the summarizer for no characters at all.
function assertRoomFor(budget, limit) {
	if (budget < 1) throw new RangeError(`the memory limit ${limit} is too small to fit a note`)
}

export function planTurnNote({ prompt = '', thinking = '', response = '' }, limit) {
	if (!Number.isInteger(limit) || limit < 1) {
		throw new RangeError(`the memory limit must be a positive whole number, got ${limit}`)
	}

	if (compose({ prompt, thinking, response }).length <= limit) {
		return {
			layer: 1,
			includeThinking: true,
			promptBudget: null,
			responseBudget: null
		}
	}

	if (compose({ prompt, response }).length <= limit) {
		return {
			layer: 2,
			includeThinking: false,
			promptBudget: null,
			responseBudget: null
		}
	}

	if (prompt.length <= limit / 2) {
		const used = LABELS.prompt.length + prompt.length + SEPARATOR.length + LABELS.responseSummary.length
		assertRoomFor(limit - used, limit)

		return {
			layer: '3a',
			includeThinking: false,
			promptBudget: null,
			responseBudget: limit - used
		}
	}

	const available = limit - LABELS.promptSummary.length - SEPARATOR.length - LABELS.responseSummary.length
	const promptBudget = Math.floor(available / 2)
	assertRoomFor(promptBudget, limit)

	return {
		layer: '3b',
		includeThinking: false,
		promptBudget,
		responseBudget: available - promptBudget
	}
}

// Text within its budget is kept as it is; longer text is replaced by its summary.
async function fit(text, budget, summarize) {
	if (budget === null || text.length <= budget) return text

	return { summary: await summarize(text, budget) }
}

// The note for one turn. A failing summarizer rejects, so nothing half-made is ever returned.
export async function buildTurnNote({ prompt = '', thinking = '', response = '' }, limit, summarize) {
	const plan = planTurnNote({ prompt, thinking, response }, limit)

	// Both summaries are asked at once in layer 3b, so the wait is one call, not two.
	const [promptField, responseField] = await Promise.all([
		fit(prompt, plan.promptBudget, summarize),
		fit(response, plan.responseBudget, summarize),
	])

	return compose({
		prompt: promptField,
		thinking: plan.includeThinking ? thinking : '',
		response: responseField,
	})
}
