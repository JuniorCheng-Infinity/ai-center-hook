#!/usr/bin/env node
// UserPromptSubmit — shows one line about hook failures that could not be shown when they happened.
import { runAiCenterHook, takePendingSummary } from './lib/connection/hook-failures.mjs'
import { readStdinJson } from './lib/hook-utils.mjs'

await runAiCenterHook(async () => {
  await readStdinJson()

  const summary = takePendingSummary()
  if (summary) process.stdout.write(JSON.stringify({ systemMessage: summary }))
})
