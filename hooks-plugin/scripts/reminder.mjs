#!/usr/bin/env node
// UserPromptSubmit — fires at the start of every turn, before the AI starts
// processing it. Re-delivers a short memory_search/update/delete reminder
// fresh every turn, since Phase 3's `instructions` (sent once, at connection
// time) is easy to lose track of in a long session. Makes no network call at
// all: reads the project-id cache context.mjs already wrote this session
// (read-only — if it's missing, skips silently rather than forcing a real
// initialize() call just for a reminder).
import { readProjectCache } from './lib/connection/cache.mjs'
import { resolveHookConnection } from './lib/connection/client-connections.mjs'
import { runAiCenterHook } from './lib/connection/hook-failures.mjs'
import { readStdinJson } from './lib/hook-utils.mjs'

await runAiCenterHook(async () => {
  const input = await readStdinJson()
  const connection = resolveHookConnection(input)

  const projectId = readProjectCache(connection)
  if (projectId === undefined) return

  const additionalContext = `
    ai-center project_id ${projectId}
    Use memory_search to recall,
    memory_update to correct,
    memory_delete to forget.
  `
  
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } }))
})
