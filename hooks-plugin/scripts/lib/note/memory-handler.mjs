// Decides what content one memory write may carry. The limit is passed in; it comes from the backend.

// Used only when the backend's limit cannot be read (the backend's own default for memory_add).
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
function labelled(field, label, summaryLabel) {
	if (typeof field !== 'string') return summaryLabel + field.summary
	return (field.startsWith('\n') ? label.trimEnd() : label) + field
}

// The one place that joins the sections, so the length counted and the text sent can never drift apart.
function compose({ prompt, thinking, response }) {
	const parts = []

	if (prompt) parts.push(labelled(prompt, LABELS.prompt, LABELS.promptSummary))
	if (thinking) parts.push(LABELS.thinking + thinking)
	if (response) parts.push(labelled(response, LABELS.response, LABELS.responseSummary))

	return parts.join(SEPARATOR)
}

// A limit that cannot even hold the labels would ask the summarizer for no characters at all.
function assertRoomFor(budget, limit) {
	if (budget < 1) throw new RangeError(`the memory limit ${limit} is too small to fit a note`)
}

export function memoryAddContent({ prompt = '', thinking = '', response = '' }, limit) {
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
export async function memoryAddTurn({ prompt = '', thinking = '', response = '' }, limit, summarize) {
	const plan = memoryAddContent({ prompt, thinking, response }, limit)

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
