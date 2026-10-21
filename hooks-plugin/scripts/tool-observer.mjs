#!/usr/bin/env node
// SWITCHED OFF: hooks/hooks.json still lists this script, but its matcher is "__disabled__", which matches no
// tool name, so no memory_add is made per tool call (the turn note lists the tools used in a turn instead).
// To switch it on again, set that matcher back to ".*".
//
// PostToolUse (matcher "*") — fires after every tool call, deterministically,
// regardless of whether the model would have chosen to record anything.
// Sends a compact, uncurated record of the call; supermemory's own
// extraction (POST /v4/memories) does the actual processing, not this script.
import { callTool, resolveProjectId } from './lib/connection/ai-center-mcp.mjs'
import { resolveHookConnection } from './lib/connection/client-connections.mjs'
import { runAiCenterHook } from './lib/connection/hook-failures.mjs'
import { readStdinJson } from './lib/hook-utils.mjs'

const MAX_FIELD_CHARS = 500
// Claude Code names ai-center's tools mcp__ai-center__*, Codex mcp__ai_center__*.
const AI_CENTER_TOOL_NAME = /^mcp__ai[-_]center__/

function truncate(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? 'null'
  return text.length > MAX_FIELD_CHARS ? `${text.slice(0, MAX_FIELD_CHARS)}…` : text
}

await runAiCenterHook(async () => {
  const input = await readStdinJson()
  if (AI_CENTER_TOOL_NAME.test(input.tool_name)) return

  const connection = resolveHookConnection(input)

  const projectId = await resolveProjectId(connection)

  const content = [
    `Tool: ${input.tool_name ?? 'unknown'}`,
    `Input: ${truncate(input.tool_input)}`,
    `Result: ${truncate(input.tool_response)}`,
  ].join('\n')

  await callTool(connection, 'memory_add', { project_id: projectId, content })
})
