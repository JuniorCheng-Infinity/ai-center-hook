#!/usr/bin/env node
// A repeat Stop in the same turn updates that note instead of adding a second one.
// The first Stop of a turn searches for the earlier note of the same work and updates it when the hook wrote it itself;
// otherwise it adds. Either way the decision travels in _meta for the request monitor, never into the memory.
import { AiCenterError, callToolWithRequestId, resolveProjectId } from './lib/connection/ai-center-mcp.mjs'
import { readAddContentLimit, readTurnNoteIds, writeTurnNoteId } from './lib/connection/cache.mjs'
import { detectPlatform, resolveHookConnection } from './lib/connection/client-connections.mjs'
import { contentSummarizer } from './lib/note/content-summarizer.mjs'
import { promptFormatter, usageFormatter } from './lib/note/field-formatter.mjs'
import { runAiCenterHook } from './lib/connection/hook-failures.mjs'
import { errorMessage, readStdinJson } from './lib/hook-utils.mjs'
import { DEFAULT_ADD_CONTENT_MAX_CHARS, memoryAddTurn } from './lib/note/memory-handler.mjs'
import { chooseNoteToUpdate, lookupQuery } from './lib/note/note-lookup.mjs'
import { readTurn } from './lib/note/turn-transcript.mjs'

const SEARCH_TIMEOUT_MS = 5_000

// Looks for the earlier note of the same work. A search that fails never costs the note: it is added instead.
async function chooseEarlierNote(connection, projectId, query) {
	let searchRequestId = null
	try {
		const search = await callToolWithRequestId(
			connection,
			'memory_search',
			{ 
				project_id: projectId, query 
			},
			{ 
				timeoutMs: SEARCH_TIMEOUT_MS 
			},
		)
		searchRequestId = search.requestId
		const hits = JSON.parse(search.result.content[0].text)
		const chosen = chooseNoteToUpdate(hits, new Set(Object.values(readTurnNoteIds())))
		if (chosen) {
			const reason = 'most similar earlier turn note'
			return { 
				noteId: chosen.id, 
				lookup: { 
					searchRequestId, 
					decision: 'update', 
					reason, 
					selectedId: chosen.id 
				} 
			}
		}
		return {
			lookup: { 
				searchRequestId, 
				decision: 'add', 
				reason: 'no earlier turn note found', 
				selectedId: null 
			}
		}
	} catch (error) {
		const reason = `search failed: ${errorMessage(error)}`
		const failedId = searchRequestId ?? error.requestId ?? null
		return { 
			lookup: { 
				searchRequestId: failedId, 
				decision: 'add', 
				reason, 
				selectedId: null 
			} 
		}
	}
}

async function addNote(connection, projectId, content, usage, lookup) {
	const { result } = await callToolWithRequestId(
		connection,
		'memory_add',
		{ 
			project_id: projectId, 
			content 
		},
		{
			usage, 
			lookup 
		},
	)
	return result
}

async function saveNote(connection, projectId, content, { noteId, lookup }, usage) {
	if (noteId) {
		try {
			const { result } = await callToolWithRequestId(
				connection,
				'memory_update',
				{
					project_id: projectId,
					memory_id: noteId,
					new_content: content
				},
				{ 
					usage, 
					lookup 
				},
			)
			return result
		} catch (error) {
			// A note that no longer exists (404) is added again; any other failure is reported.
			if (!(error instanceof AiCenterError) || error.statusCode !== 404) throw error
			const gone = { ...lookup, decision: 'add', reason: `${lookup.reason}, but the note no longer exists` }
			return addNote(connection, projectId, content, usage, gone)
		}
	}
	return addNote(connection, projectId, content, usage, lookup)
}

function savedNoteId(result) {
	try {
		const { id } = JSON.parse(result.content[0].text)
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
	const summarize = (text, budget) => contentSummarizer(text, { budget, platform })
	const content = await memoryAddTurn({ prompt, thinking, response }, limit, summarize)

	// Claude Code identifies a turn by prompt_id, Codex by turn_id.
	const turnId = input.prompt_id ?? input.turn_id
	const knownNoteId = turnId ? readTurnNoteIds()[turnId] : undefined
	// A repeat Stop already knows its note, so it does not search again.
	const sameTurn = { searchRequestId: null, decision: 'update', reason: 'same turn', selectedId: knownNoteId }
	const choice = knownNoteId
		? { noteId: knownNoteId, lookup: sameTurn }
		: await chooseEarlierNote(connection, projectId, lookupQuery({ prompt, response }))
	const result = await saveNote(connection, projectId, content, choice, usage)

	const noteId = savedNoteId(result)
	if (turnId && noteId) writeTurnNoteId(turnId, noteId)
})
