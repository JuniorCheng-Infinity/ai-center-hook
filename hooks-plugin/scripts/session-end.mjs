#!/usr/bin/env node
// SessionEnd — clears this connection's cached project id so the next
// session always starts from a fresh resolution (see context.mjs, which
// never trusts a pre-existing cache either way). Fire-and-forget, same as
// every other hook here: a cleanup failure must never surface to the user.
import { clearProjectCache } from './lib/connection/cache.mjs'
import { resolveHookConnection } from './lib/connection/client-connections.mjs'
import { runAiCenterHook } from './lib/connection/hook-failures.mjs'
import { readStdinJson } from './lib/hook-utils.mjs'

await runAiCenterHook(async () => {
  const input = await readStdinJson()
  const connection = resolveHookConnection(input)

  clearProjectCache(connection)
})
