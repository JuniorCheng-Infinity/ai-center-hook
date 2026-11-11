import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildTurnNoteScope } from '../scripts/lib/connection/cache.mjs'

const cacheUrl = new URL('../scripts/lib/connection/cache.mjs', import.meta.url).href
const lockOwnerScript = `
	import { withTurnNoteLock } from ${JSON.stringify(cacheUrl)}
	await withTurnNoteLock('test', async () => {
		process.stdout.write('locked')
		await new Promise(() => { setInterval(() => {}, 1000) })
	})
`

// cache.mjs finds its folder from HOME when it is loaded, so each case runs in a fresh process with its own HOME.
function inFakeHome(script) {
	const home = mkdtempSync(join(tmpdir(), 'ai-center-cache-test-'))
	try {
		const code = [
			`import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'`,
			`import { spawn } from 'node:child_process'`,
			`import { once } from 'node:events'`,
			`import { pruneTurnNoteFiles, readAddContentLimit, readProjectCache, withTurnNoteLock, writeProjectCache } from ${JSON.stringify(cacheUrl)}`,
			`const connection = { baseUrl: 'http://cache.test', apiKey: 'key' }`,
			`const dir = process.env.HOME + '/.cache/ai-center-hooks'`,
			`const overwrite = (text) => writeFileSync(dir + '/' + readdirSync(dir).find((name) => name.endsWith('.json')), text)`,
			`const show = () => console.log(JSON.stringify({
					id: readProjectCache(connection), limit: readAddContentLimit(connection),
				}))`,
			`const startLockOwner = async () => {
				const owner = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(lockOwnerScript)}], {
					stdio: ['ignore', 'pipe', 'inherit'], env: process.env,
				})
				try {
					await once(owner.stdout, 'data', { signal: AbortSignal.timeout(3000) })
					return owner
				} catch (error) { owner.kill('SIGKILL'); throw error }
			}`,
			script,
		].join('\n')
		const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
			env: { ...process.env, HOME: home },
			encoding: 'utf8',
			timeout: 15_000,
		})
		assert.equal(result.status, 0, result.stderr)
		return JSON.parse(result.stdout)
	} finally {
		rmSync(home, { recursive: true, force: true })
	}
}

test('the project id and the content limit are written and read together', () => {
	const read = inFakeHome('writeProjectCache(connection, 7, 5000); show()')
	assert.deepEqual(read, { id: 7, limit: 5000 })
})

test('a cache written without a limit reads as no limit', () => {
	const read = inFakeHome('writeProjectCache(connection, 7); show()')
	assert.deepEqual(read, { id: 7 })
})

test('a nothing-yet cache reads as nothing', () => {
	assert.deepEqual(inFakeHome('show()'), {})
})

test('values of the wrong kind are ignored', () => {
	const read = inFakeHome(
		`writeProjectCache(connection, 1, 1); overwrite('{"projectId":"7","addContentMaxChars":-5}'); show()`,
	)
	assert.deepEqual(read, {})
})

test('a damaged file reads as nothing and does not stop the hook', () => {
	const read = inFakeHome(`writeProjectCache(connection, 1, 1); overwrite('{not json'); show()`)
	assert.deepEqual(read, {})
})

test('turn-note files untouched for a day are removed, and nothing else is', () => {
	const left = inFakeHome(`
		mkdirSync(dir, { recursive: true })
		const hoursAgo = (hours) => new Date(Date.now() - hours * 60 * 60 * 1000)
		const plant = (name, age) => {
			writeFileSync(dir + '/' + name, '{}')
			utimesSync(dir + '/' + name, age, age)
		}
		for (const name of ['turn-notes-a.json', 'turn-notes-a.json.lock', 'turn-notes.json']) plant(name, hoursAgo(25))
		for (const name of ['abc.json', 'failures.jsonl']) plant(name, hoursAgo(25))
		plant('turn-notes-b.json', hoursAgo(23))
		pruneTurnNoteFiles()
		console.log(JSON.stringify(readdirSync(dir).sort()))
	`)
	assert.deepEqual(left, ['abc.json', 'failures.jsonl', 'turn-notes-b.json'])
})

test('pruning without a cache folder does nothing and does not stop the hook', () => {
	assert.deepEqual(inFakeHome('pruneTurnNoteFiles(); console.log("{}")'), {})
})

test('a failed save releases its lock so a subsequent save can proceed', () => {
	const result = inFakeHome(`
		let failure
		try {
			await withTurnNoteLock('test', async () => { throw new Error('save failed') })
		} catch (error) { failure = error.message }
		const next = await withTurnNoteLock('test', async () => 'saved')
		console.log(JSON.stringify({ failure, next }))
	`)
	assert.deepEqual(result, { failure: 'save failed', next: 'saved' })
})

test('a lock held by a live process times out without saving or disturbing the owner', () => {
	const result = inFakeHome(`
		const owner = await startLockOwner()
		let called = false
		let failure
		try {
			await withTurnNoteLock('test', async () => { called = true })
		} catch (error) { failure = error.message }
		finally {
			const stillAlive = owner.exitCode === null && owner.signalCode === null
			const exited = once(owner, 'exit')
			owner.kill('SIGKILL')
			await exited
			console.log(JSON.stringify({ failure, called, stillAlive }))
		}
	`)
	assert.deepEqual(result, {
		failure: 'Timed out waiting for the turn-note save lock', called: false, stillAlive: true,
	})
})

test('a lock left by a killed process is taken over at once and removed after the save', () => {
	const result = inFakeHome(`
		const owner = await startLockOwner()
		const exited = once(owner, 'exit')
		owner.kill('SIGKILL')
		await exited
		const next = await withTurnNoteLock('test', async () => 'recovered')
		console.log(JSON.stringify({ next, fileExists: existsSync(dir + '/turn-notes-test.json.lock') }))
	`)
	assert.deepEqual(result, { next: 'recovered', fileExists: false })
})

test('an empty lock file older than the stale limit does not block saving', () => {
	const result = inFakeHome(`
		mkdirSync(dir, { recursive: true })
		const lock = dir + '/turn-notes-test.json.lock'
		writeFileSync(lock, '')
		const old = new Date(Date.now() - 60_000)
		utimesSync(lock, old, old)
		const next = await withTurnNoteLock('test', async () => 'saved')
		console.log(JSON.stringify({ next }))
	`)
	assert.deepEqual(result, { next: 'saved' })
})

test('a save does not remove a lock that another process took over', () => {
	const result = inFakeHome(`
		const lock = dir + '/turn-notes-test.json.lock'
		await withTurnNoteLock('test', async () => { writeFileSync(lock, '999999') })
		console.log(JSON.stringify({ owner: readFileSync(lock, 'utf8') }))
	`)
	assert.deepEqual(result, { owner: '999999' })
})

test('turn scopes isolate projects and clients and support transcript identity fallback', () => {
	const connection = { baseUrl: 'http://test.invalid', apiKey: 'test-key' }
	const scope = buildTurnNoteScope(connection, 1, 'claude-code', { session_id: 's' })
	assert.notEqual(scope, buildTurnNoteScope(connection, 2, 'claude-code', { session_id: 's' }))
	assert.notEqual(scope, buildTurnNoteScope(connection, 1, 'codex-mcp-client', { session_id: 's' }))
	assert.equal(buildTurnNoteScope(connection, 1, 'claude-code', {}), undefined)
	assert.equal(buildTurnNoteScope(connection, 1, 'claude-code', {}, '/tmp/session.jsonl'),
		buildTurnNoteScope(connection, 1, 'claude-code', {}, '/tmp/session.jsonl'))
	assert.notEqual(buildTurnNoteScope(connection, 1, 'claude-code', {}, '/tmp/session.jsonl'),
		buildTurnNoteScope(connection, 1, 'claude-code', {}, '/tmp/other-session.jsonl'))
})
