import {
	AiCenterError,
	callToolWithRequestId,
	resolveProjectId,
} from './lib/connection/ai-center-mcp.mjs'
import {
	readAddContentLimit,
	readTurnNoteIds,
	buildTurnNoteScope,
	withTurnNoteLock,
	writeTurnNoteId,
} from './lib/connection/cache.mjs'
import { detectPlatform, resolveHookConnection } from './lib/connection/client-connections.mjs'
import { summarizeContent } from './lib/note/content-summarizer.mjs'
import { promptFormatter, usageFormatter } from './lib/note/field-formatter.mjs'
import { runAiCenterHook } from './lib/connection/hook-failures.mjs'
import { errorMessage, parseToolResult, readStdinJson } from './lib/hook-utils.mjs'
import { DEFAULT_ADD_CONTENT_MAX_CHARS, buildTurnNote } from './lib/note/memory-handler.mjs'
import { chooseNoteToUpdate, buildLookupQuery, hasNoSourceDocuments } from './lib/note/note-lookup.mjs'
import { readTurn } from './lib/note/turn-transcript.mjs'

const SEARCH_TIMEOUT_MS = 30_000

// Looks for the earlier note of the same work. A search that fails never costs the note: it is added instead.
async function searchEarlierNote(connection, projectId, query) {
	let searchRequestId = null
	try {
		const search = await callToolWithRequestId(
			connection,
			'memory_search',
			{
				project_id: projectId,
				query,
			},
			{
				timeoutMs: SEARCH_TIMEOUT_MS
			},
		)
		searchRequestId = search.requestId
		const hits = parseToolResult(search.result)
		const chosen = chooseNoteToUpdate(hits)
		if (chosen) {
			const reason = 'most similar earlier turn note'
			return { noteId: chosen.included.document.id, lookup: { searchRequestId, decision: 'update', reason, selectedId: chosen.id } }
		}
		const reason = hasNoSourceDocuments(hits)
			? 'no earlier turn note found, and the hits name no source document (is search.include.documents on?)'
			: 'no earlier turn note found'
		return { lookup: { searchRequestId, decision: 'add', reason, selectedId: null } }
	} catch (error) {
		const reason = `search failed: ${errorMessage(error)}`
		const failedId = searchRequestId ?? error.requestId ?? null
		return { lookup: { searchRequestId: failedId, decision: 'add', reason, selectedId: null } }
	}
}

// Add and update share the same request path and monitoring metadata.
async function saveNote(connection, projectId, content, { noteId, lookup }, usage) {
	try {
		const { result } = await callToolWithRequestId(
			connection,
			noteId ? 'document_update' : 'document_add',
			noteId
				? { project_id: projectId, document_id: noteId, new_content: content }
				: { project_id: projectId, content },
			{ usage, lookup },
		)
		return result
	} catch (error) {
		// Only a missing update target falls back to add. Other failures must not create duplicates.
		if (!noteId || !(error instanceof AiCenterError) || error.statusCode !== 404) throw error
		const gone = { ...lookup, decision: 'add', reason: `${lookup.reason}, but the note no longer exists` }
		return saveNote(connection, projectId, content, { lookup: gone }, usage)
	}
}

function readSavedNoteId(result) {
	try {
		const { id } = parseToolResult(result)
		return typeof id === 'string' ? id : undefined
	} catch {
		return undefined
	}
}

await runAiCenterHook(async () => {
	const input = await readStdinJson()

	const platform = detectPlatform()
	const transcriptPath = input.transcript_path ?? process.env.CLAUDE_TRANSCRIPT_PATH
	const turn = transcriptPath ? readTurn(transcriptPath, input.prompt_id, platform) : undefined

	// Runs started by a script or another tool are not conversations, so they leave no turn note.
	if (turn?.programmatic) return

	// The note keeps the text as it was typed and written. The tools, skills and MCP tools the turn used are for the
	// request monitor only, so they go in _meta (see saveNote) and never into the memory or its length limit.
	const prompt = promptFormatter(turn?.prompts)
	// Empty thinking blocks are dropped so no blank section is saved.
	const thinking = (turn?.thinking ?? []).filter((text) => text.trim().length > 0).join('\n\n')
	const usage = usageFormatter({ tools: turn?.tools, skills: turn?.skills, mcp: turn?.mcp })
	const response = input.last_assistant_message ?? ''
	if (!prompt && !thinking && !response) return

	const connection = resolveHookConnection(input)
	const projectId = await resolveProjectId(connection)

	// A turn that is too long for one note is summarized. A failed summary throws before anything is saved,
	// and the hook reports it, so the loss is visible and can be debugged.
	const limit = readAddContentLimit(connection) ?? DEFAULT_ADD_CONTENT_MAX_CHARS
	const summarize = (text, budget) => summarizeContent(text, { budget, platform })
	const content = await buildTurnNote({ prompt, thinking, response }, limit, summarize)

	// Claude Code identifies a turn by prompt_id, Codex by turn_id.
	const turnId = input.prompt_id ?? input.turn_id
	const scope = buildTurnNoteScope(connection, projectId, platform, input, transcriptPath)
	const readKnownNoteId = () => (turnId && scope ? readTurnNoteIds(scope)[turnId] : undefined)

	// A repeat Stop already knows its note, so it does not search. The search only reads, so it runs before the lock and
	// the lock is held for the save alone.
	const earlier = readKnownNoteId()
		? undefined
		: await searchEarlierNote(connection, projectId, buildLookupQuery({ prompt, response }))

	const persist = async () => {
		// Read after acquiring the lock so the preceding save's ID is visible.
		const sameTurnNoteId = readKnownNoteId()
		const sameTurn = { searchRequestId: null, decision: 'update', reason: 'same turn', selectedId: sameTurnNoteId }
		const newTurn = { searchRequestId: null, decision: 'add', reason: 'new conversation turn', selectedId: null }
		const choice = sameTurnNoteId ? { noteId: sameTurnNoteId, lookup: sameTurn } : earlier ?? { lookup: newTurn }
		const result = await saveNote(connection, projectId, content, choice, usage)

		const noteId = readSavedNoteId(result)
		if (turnId && scope && noteId) writeTurnNoteId(scope, turnId, noteId)
	}

	if (scope) {
		await withTurnNoteLock(scope, persist)
	} else {
		await persist()
	}
})
