#!/usr/bin/env node
// UserPromptSubmit — fires at the start of every turn, before the AI starts
// processing it. Re-delivers the memory decision policy
// fresh every turn, since the server's `instructions` (sent once, at connection
// time) is easy to lose track of in a long session. Makes no network call at
// all: reads the project-id cache context.mjs already wrote this session
// (read-only — if it's missing, skips silently rather than forcing a real
// initialize() call just for a reminder).
import { readProjectCache } from './lib/connection/cache.mjs'
import { resolveHookConnection } from './lib/connection/client-connections.mjs'
import { runAiCenterHook } from './lib/connection/hook-failures.mjs'
import { readStdinJson, writeHookContext } from './lib/hook-utils.mjs'
// These decisions require understanding the fact, not just a search similarity score.
const FACT_MEMORY_POLICY = [
	'For factual memories, use project-wide memory_search before deciding to write.',
	'If new information corrects or supersedes an existing fact, memory_search then document_update the document it came from (the included.document.id of the hit), preserving details that remain true.',
	'If related information adds something distinct, use document_add for the new fact.',
	'If the same fact already exists with no meaningful change, skip writing.',
	'For facts, similarity identifies candidates; even 70% or higher does not by itself justify replacing a memory.',
	'Conversation logs are saved by the Stop hook: it searches the earlier logs and updates the most similar one, otherwise it adds a new log. Do not rewrite logs yourself to correct facts.',
].join('\n')

await runAiCenterHook(async () => {
	const input = await readStdinJson()
	const connection = resolveHookConnection(input)

	const projectId = readProjectCache(connection)
	if (projectId === undefined) return

	const additionalContext = [
		`ai-center project_id ${projectId}`,
		FACT_MEMORY_POLICY,
		'Use memory_forget to forget a memory that is no longer relevant.',
	].join('\n')

	writeHookContext('UserPromptSubmit', additionalContext)
})
