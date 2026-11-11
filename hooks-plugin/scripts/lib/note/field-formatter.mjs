// How the hook formats what it sends: the prompts of a turn, and the usage text (tools, skills and MCP tools) that
// travels in _meta for the request monitor, plus excerpts shown during recall.
// The line prefixes are fixed, so the monitor can read them back.
// This file reads nothing from disk.
const SKILL_LINE_PREFIX = 'skill: '
const TOOL_LINE_PREFIX = 'tool: '
const MCP_LINE_PREFIX = 'mcp: '

// One prompt stays exactly as typed. Several prompts of one turn become a numbered list that starts on a new
// line, so the note keeps a single "User prompt:" label.
export function promptFormatter(prompts = []) {
	if (prompts.length <= 1) return prompts[0] ?? ''
	return `\n${prompts.map((prompt, index) => `${index + 1}. ${prompt}`).join('\n')}`
}

// The usage text of a turn, for the request monitor: tools, skills and MCP tools, each on its own line and each
// name once, in first-use order. A line with no names is left out, so a turn that used nothing gives an empty text.
export function usageFormatter({ tools = [], skills = [], mcp = [] } = {}) {
	const lines = [
		[TOOL_LINE_PREFIX, tools],
		[SKILL_LINE_PREFIX, skills],
		[MCP_LINE_PREFIX, mcp],
	]
	return lines
		.map(([prefix, names]) => ({ prefix, names: [...new Set(names)] }))
		.filter(({ names }) => names.length > 0)
		.map(({ prefix, names }) => prefix + names.join(', '))
		.join('\n')
}

// Short display text shared by both recall hooks.
const MAX_MEMORY_CHARS = 300

export function memoryPreview(memory) {
	const text = memory.replace(/\s+/g, ' ').trim()
	return text.length > MAX_MEMORY_CHARS ? `${text.slice(0, MAX_MEMORY_CHARS)}…` : text
}

// One recall line: the kind, the ids, the date and the text.
export function recallLineFormatter({ kind, id, documentId, title, updatedAt, text }) {
	const cleanTitle = title ? title.replace(/\s+/g, ' ').trim() : ''
	const source = documentId ? ` doc=${documentId}${cleanTitle ? ` "${cleanTitle}"` : ''}` : ''
	return `[${kind}]${id ? ` id=${id}` : ''}${source} ${updatedAt.slice(0, 10)} ${memoryPreview(text)}`
}
