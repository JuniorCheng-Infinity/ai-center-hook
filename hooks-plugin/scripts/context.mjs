#!/usr/bin/env node
// SessionStart — deterministic recall, no model cooperation needed. Calls
// memory_search and hands the results back via the hook's own JSON output
// (hookSpecificOutput.additionalContext), which the harness injects into
// context automatically. Also the one place that always refreshes the
// cached project id for this session (resolveAndCacheProject) — every
// other hook this session just reads what this one wrote.
import { callTool, resolveAndCacheProject } from './lib/connection/ai-center-mcp.mjs'
import { resolveHookConnection } from './lib/connection/client-connections.mjs'
import { runAiCenterHook } from './lib/connection/hook-failures.mjs'
import { readStdinJson } from './lib/hook-utils.mjs'

const MAX_MEMORY_CHARS = 300
const TOOL_CAPTURE_PREFIX = 'Tool:'

// A long turn note must not flood the start of a session.
function shorten(memory) {
  const text = memory.replace(/\s+/g, ' ').trim()
  return text.length > MAX_MEMORY_CHARS ? `${text.slice(0, MAX_MEMORY_CHARS)}…` : text
}

await runAiCenterHook(async () => {
  const input = await readStdinJson()
  const connection = resolveHookConnection(input)

  const project = await resolveAndCacheProject(connection)

  // The project name finds the project's own memories.
  const result = await callTool(connection, 'memory_search', { project_id: project.id, query: project.name })
  const memories = JSON.parse(result.content[0].text).filter((memory) => !memory.memory.startsWith(TOOL_CAPTURE_PREFIX))

  const additionalContext = memories.length
    ? ['Relevant memory from ai-center:', ...memories.map((memory) => `- ${shorten(memory.memory)}`)].join('\n')
    : 'ai-center: no prior memory found for this project yet.'

  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }))
})
