#!/usr/bin/env node
// Prints one kind of notice for the user, at most once per session, without a model.
import { detectPlatform, resolveHookConnection } from './lib/connection/client-connections.mjs'
import { runAiCenterHook } from './lib/connection/hook-failures.mjs'
import { readStdinJson, writeHookNotice } from './lib/hook-utils.mjs'
import { claimNotice } from './lib/notice/guards.mjs'
import { checkForUpdate } from './lib/notice/update.mjs'

// The kinds of notice, each giving the text to show or nothing.
const NOTICES = {
	update: checkForUpdate,
}

await runAiCenterHook(async () => {
	const input = await readStdinJson()
	const kind = process.argv[2]
	if (!Object.hasOwn(NOTICES, kind)) {
		throw new Error(`notice.mjs needs an argument: ${Object.keys(NOTICES).join(' or ')}`)
	}
	const connection = resolveHookConnection(input)
	const text = await NOTICES[kind]({ connection, platform: detectPlatform() })
	if (text && claimNotice({ kind, input })) writeHookNotice(text)
})
