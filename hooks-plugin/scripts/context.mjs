#!/usr/bin/env node
// SessionStart, deterministic and without a model. Two hooks run this one script so that each has its own output
// budget: "rules" prints the user's rules and culture, "progress" prints where the work stands. Only "progress"
// refreshes the cached project id and prunes old turn-note files.
import { callTool, fetchUserId, resolveAndCacheProject, resolveProjectId } from './lib/connection/ai-center-mcp.mjs'
import { pruneTurnNoteFiles } from './lib/connection/cache.mjs'
import { PLATFORM, detectPlatform, resolveHookConnection } from './lib/connection/client-connections.mjs'
import { reportFailure, runAiCenterHook } from './lib/connection/hook-failures.mjs'
import { parseToolResult, readStdinJson, writeHookContext } from './lib/hook-utils.mjs'
import { dropRepeatedEntries, findClosingBlock, readTurnNote } from './lib/note/memory-handler.mjs'

// The most characters one hook may print. Claude Code cuts a hook's output at 10,000 characters and Codex at about
// 2,500 tokens, and the AI never sees the cut part, so each client gets a limit below its own cut-off.
const OUTPUT_LIMITS = {
	[PLATFORM.claudeCode]: 9_500,
	[PLATFORM.codex]: 7_000,
}
// A client that cannot be recognized gets the smallest limit, so the worst case is still safe.
const CEILING = OUTPUT_LIMITS[detectPlatform()] ?? Math.min(...Object.values(OUTPUT_LIMITS))
// A prompt, a closing block, a rule or a fact above this is pointed to or left out, never shown cut.
const LONG_ENTRY = 800
// The recent notes are looked for in two lists, the newest updated and the newest created, this many from each.
const LIST_SIZE = 5
// Every turn updates its own note and pushes the notes the AI wrote out of the short lists, so the newest
// documents are looked through for them: 100 is the most one list request returns.
const NOTE_SEARCH_SIZE = 100
// How many recent facts from the profile are shown.
const FACT_COUNT = 10
// A compaction summary stored as a prompt says nothing about what the user asked.
const COMPACTION_PROMPT = /^(?:Continued from a session|This session is being continued from a previous conversation)/

async function readReply(connection, name, args) {
	return parseToolResult(await callTool(connection, name, args))
}

// An entry without text is skipped, and the skip is shown once with its count.
function keepEntriesWithText(entries) {
	const withText = entries.filter((entry) => typeof entry?.memory === 'string' && entry.memory.trim())
	if (withText.length < entries.length) {
		reportFailure(new Error(`profile entries without text skipped: ${entries.length - withText.length}`))
	}
	return withText
}

const moreRulesNote = (count) => `(${count} more ${count === 1 ? 'rule' : 'rules'} not shown: call profile_get)`

async function buildRulesContext(connection) {
	const projectId = await resolveProjectId(connection)
	const userId = await fetchUserId(connection)
	const { profile } = await readReply(connection, 'profile_get', {
		project_id: projectId, user_id: userId, buckets: ['preferences'],
	})
	const entries = [...(profile.static ?? []), ...(profile.buckets?.preferences ?? [])]
	const rules = dropRepeatedEntries(keepEntriesWithText(entries))
	if (rules.length === 0) return ''

	const header = 'ai-center: your rules and culture'
	// Room for the longest possible "more rules" note is kept free, so the list never needs a second cut.
	const room = CEILING - moreRulesNote(rules.length).length - 1
	const lines = []
	let used = header.length
	let full = false
	let leftOut = 0
	for (const { memory } of rules) {
		const line = `- ${memory}`
		const tooLong = memory.length > LONG_ENTRY
		if (!tooLong && !full && used + line.length + 1 <= room) {
			lines.push(line)
			used += line.length + 1
			continue
		}
		if (!tooLong) full = true
		leftOut += 1
	}
	return [header, ...lines, ...(leftOut ? [moreRulesNote(leftOut)] : [])].join('\n')
}

const isTurnNote = (document) => typeof document.title === 'string' && document.title.startsWith('User prompt')
const stamp = (document, field) => document.system?.[field] ?? ''

const documentsIn = (...replies) => new Map(replies.flatMap((reply) => reply.documents ?? []).map((d) => [d.id, d]))
const newestFirst = (a, b) =>
	stamp(b, 'updatedAt').localeCompare(stamp(a, 'updatedAt')) ||
	stamp(b, 'createdAt').localeCompare(stamp(a, 'createdAt'))

// The turns are the union of the newest few by update and the newest few by creation: each finds what the other
// misses. The notes the AI wrote are also looked for among the newest NOTE_SEARCH_SIZE.
async function recentDocuments(connection, projectId, userId) {
	const list = (sort, limit) => readReply(connection, 'document_list', {
		project_id: projectId, user_id: userId, sort, order: 'desc', limit,
	})
	const [byUpdate, byCreation, newest] = await Promise.all([
		list('updatedAt', LIST_SIZE), list('createdAt', LIST_SIZE), list('updatedAt', NOTE_SEARCH_SIZE),
	])

	return {
		turnNotes: [...documentsIn(byUpdate, byCreation).values()].filter(isTurnNote).sort(newestFirst),
		aiNotes: [...documentsIn(byUpdate, byCreation, newest).values()].filter((d) => !isTurnNote(d)).sort(newestFirst),
	}
}

// A note that cannot be read, or is not a turn note, is reported and gives null, and the rest goes on.
async function readTurn(connection, projectId, document) {
	try {
		const reply = await readReply(connection, 'document_get', { project_id: projectId, document_id: document.id })
		const note = readTurnNote(reply.content)
		if (!note) throw new Error(`document ${document.id} is not a turn note`)
		if (COMPACTION_PROMPT.test(note.prompt)) return null
		return { id: document.id, prompt: note.prompt, closing: findClosingBlock(note.response, LONG_ENTRY) }
	} catch (error) {
		reportFailure(error)
		return null
	}
}

async function recentFacts(connection, projectId, userId) {
	const { profile } = await readReply(connection, 'profile_get', { project_id: projectId, user_id: userId })
	return dropRepeatedEntries(keepEntriesWithText(profile.dynamic ?? []))
		.filter(({ memory }) => memory.length <= LONG_ENTRY)
		.slice(0, FACT_COUNT)
		.map(({ memory }) => memory)
}

const pointerTo = (what, length) => `(long ${what}, ${length} chars: open the note)`

function describeTurn({ id, prompt, closing }, number) {
	const asked = prompt.length > LONG_ENTRY ? pointerTo('prompt', prompt.length) : prompt
	const lines = [`[${number}] doc=${id}`, `asked: ${asked}`]
	if (closing) lines.push(`AI ended: ${closing.length > LONG_ENTRY ? pointerTo('closing', closing.length) : closing}`)
	return lines.join('\n')
}

function renderProgress({ turns, facts, notes }) {
	const pointers = notes.map((note, i) =>
		`[${turns.length + i + 1}] doc=${note.id}  ${(note.title ?? '').replace(/\s+/g, ' ').trim()}`)
	const sections = [
		turns.length && ['Last asked (newest first):', turns.map((turn, i) => describeTurn(turn, i + 1)).join('\n\n')],
		facts.length && ['Recent facts:', ...facts.map((fact) => `- ${fact}`)],
		pointers.length && ['Notes written by the AI (open one with document_get):', ...pointers],
	].filter(Boolean)

	if (sections.length === 0) return ''
	return ['ai-center: where the work stands', ...sections.map((lines) => lines.join('\n'))].join('\n\n')
}

// Whole entries are dropped when the output would pass the limit: the facts from the end, then the oldest turns,
// then the notes. The newest turn always stays.
function fitToCeiling({ turns, facts, notes }) {
	const kept = { turns: [...turns], facts: [...facts], notes: [...notes] }
	let text = renderProgress(kept)

	while (text.length > CEILING) {
		const dropFrom = kept.facts.length ? kept.facts : kept.turns.length > 1 ? kept.turns : kept.notes
		if (dropFrom.length === 0) break
		dropFrom.pop()
		text = renderProgress(kept)
	}
	return text
}

async function buildProgressContext(connection) {
	pruneTurnNoteFiles()
	const { id: projectId } = await resolveAndCacheProject(connection)
	const userId = await fetchUserId(connection)
	const [{ turnNotes, aiNotes }, facts] = await Promise.all([
		recentDocuments(connection, projectId, userId),
		recentFacts(connection, projectId, userId),
	])
	const read = await Promise.all(turnNotes.map((document) => readTurn(connection, projectId, document)))

	return fitToCeiling({ turns: read.filter(Boolean), facts, notes: aiNotes })
}

const BUILDERS = { rules: buildRulesContext, progress: buildProgressContext }

await runAiCenterHook(async () => {
	const input = await readStdinJson()
	const section = process.argv[2]
	if (!Object.hasOwn(BUILDERS, section)) {
		throw new Error(`context.mjs needs an argument: ${Object.keys(BUILDERS).join(' or ')}`)
	}

	const context = await BUILDERS[section](resolveHookConnection(input))
	if (context) writeHookContext('SessionStart', context)
})
