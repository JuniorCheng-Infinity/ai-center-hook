// Client-specific transcript formats and shared extraction of a single turn.
import { statSync } from 'node:fs'
import { PLATFORM } from '../connection/client-connections.mjs'
import { parseJson, readHead, readTail } from '../hook-utils.mjs'

// Read further back until the prompt of the turn is found.
const TAIL_BYTES_STEPS = [200_000, 2_000_000, 20_000_000]

// Both clients name an MCP tool mcp__<server>__<tool>.
const MCP_TOOL_PREFIX = 'mcp__'
// The folder that holds a SKILL.md, found below a skills folder.
const SKILL_FILE_PATH = /(?<![\w.-])skills\/(?:[\w.-]+\/)*?([\w.-]+)\/SKILL\.md/g

function extractThinking(content) {
	if (!Array.isArray(content)) return []
	return content
		.filter((block) => block?.type === 'thinking' && typeof block.thinking === 'string')
		.map((block) => block.thinking)
}

// Local command output arrives as a user entry that starts with a raw tag.
const SYNTHETIC_WRAPPER = /^\s*<[a-z][a-z_-]*>/i
// Claude writes this as a user entry when the user stops a turn; it is not something the user typed.
const INTERRUPT_MARKER = '[Request interrupted'

function isTypedText(text) {
	return text.trim().length > 0 && !SYNTHETIC_WRAPPER.test(text) && !text.trim().startsWith(INTERRUPT_MARKER)
}

function isGenuineUserText(content) {
	if (typeof content === 'string') return isTypedText(content)
	if (!Array.isArray(content)) return false
	return content.some((block) => block?.type === 'text' && typeof block.text === 'string' && isTypedText(block.text))
}

function extractUserText(content) {
	if (typeof content === 'string') return content
	if (!Array.isArray(content)) return ''
	return content
		.filter((block) => block?.type === 'text' && typeof block.text === 'string')
		.map((block) => block.text)
		.join('\n')
}

const isPrompt = (entry) => entry.type === 'user' && !entry.isMeta && isGenuineUserText(entry.message?.content)

// With a prompt id the prompt is the first user text carrying it; without one it is the latest user text.
function findPromptIndex(entries, promptId) {
	if (promptId) return entries.findIndex((entry) => entry.promptId === promptId && isPrompt(entry))
	return entries.findLastIndex(isPrompt)
}

// Claude Code stores messages directly, with thinking blocks in assistant content.
function normalizeClaudeEntry(entry) {
	if (entry?.type !== 'user' && entry?.type !== 'assistant') return undefined
	return entry
}

// Codex reports an MCP call as an event that names the server and the tool apart.
function normalizeCodexMcpCall(item) {
	if (typeof item.server !== 'string' || typeof item.tool !== 'string') return undefined
	const name = `${MCP_TOOL_PREFIX}${item.server}__${item.tool}`
	return { type: 'assistant', message: { content: [{ type: 'tool_use', name }] } }
}

// Codex has no Skill tool: it uses a skill by reading .../skills/<name>/SKILL.md through a shell call.
function skillsReadBy(payload) {
	const code = [payload.input, payload.arguments].find((value) => typeof value === 'string') ?? ''
	return [...code.matchAll(SKILL_FILE_PATH)].map((match) => match[1]).filter((name) => !/^\.+$/.test(name))
}

// Codex stores messages and reasoning summaries inside response_item records, and MCP calls inside events.
function normalizeCodexEntry(entry) {
	if (entry?.type === 'event_msg') {
		const { payload } = entry
		const isMcpCall = payload?.type === 'item_completed' && payload.item?.type === 'McpToolCall'
		return isMcpCall ? normalizeCodexMcpCall(payload.item) : undefined
	}
	if (entry?.type !== 'response_item') return undefined
	const payload = entry.payload
	if (payload?.type === 'message') {
		const content = Array.isArray(payload.content) ? payload.content : []
		return {
			type: payload.role,
			message: {
				content: content.filter((block) => block && typeof block === 'object').map((block) => ({
					type: block.type === 'input_text' || block.type === 'output_text' ? 'text' : block.type,
					text: block.text,
				})),
			},
		}
	}
	if (payload?.type === 'reasoning') {
		const summary = Array.isArray(payload.summary) ? payload.summary : []
		return {
			type: 'assistant',
			message: {
				content: summary
					.filter((block) => block?.type === 'summary_text' && typeof block.text === 'string')
					.map((block) => ({ type: 'thinking', thinking: block.text })),
			},
		}
	}
	// A tool call keeps its name; a skill it reads is added as a Skill call, which is how the lists find it.
	if (payload?.type === 'custom_tool_call' || payload?.type === 'function_call') {
		const skillCalls = skillsReadBy(payload).map((skill) => ({ type: 'tool_use', name: 'Skill', input: { skill } }))
		return { type: 'assistant', message: { content: [{ type: 'tool_use', name: payload.name }, ...skillCalls] } }
	}
	return undefined
}

// Codex stamps every record with the id of the turn it belongs to, which bounds a turn that has several prompts.
function normalizeCodex(entry) {
	const normalized = normalizeCodexEntry(entry)
	// A response item carries its turn id in the passthrough metadata, an event carries it on the payload.
	const turnId = entry?.payload?.internal_chat_message_metadata_passthrough?.turn_id ?? entry?.payload?.turn_id
	return normalized && turnId ? { ...normalized, turnId } : normalized
}

function normalizeEntry(entry, platform) {
	if (platform === PLATFORM.claudeCode) return normalizeClaudeEntry(entry)
	if (platform === PLATFORM.codex) return normalizeCodex(entry)
	// Unknown environments retain support through the transcript's record shape.
	return entry?.type === 'response_item' ? normalizeCodex(entry) : normalizeClaudeEntry(entry)
}

const SKILL_BODY_PREFIX = 'Base directory for this skill:'
const COMMAND_NAME = /<command-name>\/?([^<]+)<\/command-name>/
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/

const isSkillBody = (entry) =>
	entry?.type === 'user' && entry.isMeta === true && extractUserText(entry.message?.content).startsWith(SKILL_BODY_PREFIX)

// A slash command is a skill only when the skill body follows it, so built-ins like /resume stay system text.
// The command is rewritten to the text the user typed, which makes it a prompt.
function withSkillCommands(entries) {
	return entries.map((entry, index) => {
		const content = entry.message?.content
		if (entry.type !== 'user' || typeof content !== 'string') return entry

		const name = COMMAND_NAME.exec(content)?.[1]
		if (!name || !isSkillBody(entries[index + 1])) return entry

		const args = COMMAND_ARGS.exec(content)?.[1].trim()
		const typed = args ? `/${name} ${args}` : `/${name}`
		return { ...entry, skillCommand: name, message: { ...entry.message, content: typed } }
	})
}

// Names in first-use order. The Skill tool is listed as a skill, and MCP tools apart from the other tools.
function extractUsage(entries) {
	const skills = new Set()
	const tools = new Set()
	const mcp = new Set()
	for (const entry of entries) {
		if (entry.skillCommand) skills.add(entry.skillCommand)
		if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) continue

		for (const block of entry.message.content) {
			if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue
			if (block.name === 'Skill') {
				if (typeof block.input?.skill === 'string') skills.add(block.input.skill)
			} else if (block.name.startsWith(MCP_TOOL_PREFIX)) mcp.add(block.name)
			else tools.add(block.name)
		}
	}
	return { skills: [...skills], tools: [...tools], mcp: [...mcp] }
}

// Claude: an assistant step that is not a tool call ends the turn it belongs to. A subagent's own steps do not.
const endsTurn = (entry) =>
	entry.type === 'assistant' &&
	!entry.isSidechain &&
	typeof entry.message?.stop_reason === 'string' &&
	entry.message.stop_reason !== 'tool_use'

// The entries of the turn that holds the prompt at promptIndex, as [start, end). A turn can hold several prompts
// (a follow-up typed while the AI worked, or a prompt after an interrupt), so it is bounded by the turn id (Codex)
// or by the assistant steps that end turns (Claude). Without either, it runs from the prompt to the next prompt.
// openStart says the turn may have begun before the entries that were read.
function turnRange(entries, promptIndex) {
	const turnId = entries[promptIndex].turnId
	if (turnId) {
		const start = entries.findIndex((entry) => entry.turnId === turnId)
		const end = entries.findLastIndex((entry) => entry.turnId === turnId) + 1
		return { start, end, openStart: start === 0 }
	}

	if (entries.some(endsTurn)) {
		let start = promptIndex
		while (start > 0 && !endsTurn(entries[start - 1])) start--
		let last = promptIndex
		while (last < entries.length - 1 && !endsTurn(entries[last])) last++
		return { start, end: last + 1, openStart: start === 0 }
	}

	const next = entries.findIndex((entry, index) => index > promptIndex && isPrompt(entry))
	return { start: promptIndex, end: next === -1 ? entries.length : next, openStart: false }
}

function extractTurn(transcriptText, promptId, platform, canGrow = false) {
	const entries = []
	for (const line of transcriptText.split('\n')) {
		if (!line) continue
		try {
			const entry = normalizeEntry(JSON.parse(line), platform)
			if (entry) entries.push(entry)
		} catch {
			continue
		}
	}

	const withCommands = withSkillCommands(entries)
	const promptIndex = findPromptIndex(withCommands, promptId)
	if (promptIndex === -1) return undefined

	const { start, end, openStart } = turnRange(withCommands, promptIndex)
	// A larger window may show the start of the turn, so it is tried before settling for a partial turn.
	if (openStart && canGrow) return undefined

	const turnEntries = withCommands.slice(start, end)
	// prompt is the one the hook identified; prompts is every prompt of the turn, in order.
	const prompt = extractUserText(withCommands[promptIndex].message?.content)
	const prompts = turnEntries.filter(isPrompt).map((entry) => extractUserText(entry.message?.content))
	const thinking = turnEntries
		.filter((entry) => entry.type === 'assistant')
		.flatMap((entry) => extractThinking(entry.message?.content))

	// Claude marks a run started by print mode or the SDK on the prompt entry itself.
	const programmatic = withCommands[promptIndex].entrypoint === 'sdk-cli'
	return { prompt, prompts, thinking, programmatic, ...extractUsage(turnEntries) }
}

const SESSION_HEAD_BYTES = 262_144

// Codex marks a run started by `codex exec` in the first record of its session file. A Claude run has no such
// record, so its file is not even opened.
function startedByCodexExec(transcriptPath, platform) {
	if (platform === PLATFORM.claudeCode) return false
	const firstLine = readHead(transcriptPath, SESSION_HEAD_BYTES).split('\n', 1)[0]
	const payload = parseJson(firstLine)?.payload
	return payload?.source === 'exec' || payload?.originator === 'codex_exec'
}

// The prompt id is tried first, then the latest prompt.
export function readTurn(transcriptPath, promptId, platform) {
	const { size } = statSync(transcriptPath)
	for (const id of promptId ? [promptId, undefined] : [undefined]) {
		for (const [step, bytes] of TAIL_BYTES_STEPS.entries()) {
			const canGrow = bytes < size && step < TAIL_BYTES_STEPS.length - 1
			const turn = extractTurn(readTail(transcriptPath, bytes), id, platform, canGrow)
			if (turn) return { ...turn, programmatic: turn.programmatic || startedByCodexExec(transcriptPath, platform) }
		}
	}
	return undefined
}

