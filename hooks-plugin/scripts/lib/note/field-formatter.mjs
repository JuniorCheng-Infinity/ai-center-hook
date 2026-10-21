// How the hook formats what it sends: the prompts of a turn, and the usage text (tools, skills and MCP tools) that
// travels in _meta for the request monitor. The line prefixes are fixed, so the monitor can read them back.
// This file reads nothing from disk.
export const SKILL_LINE_PREFIX = 'skill: '
export const TOOL_LINE_PREFIX = 'tool: '
export const MCP_LINE_PREFIX = 'mcp: '

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
