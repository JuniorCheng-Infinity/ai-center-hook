import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isPlainObject, readSafeText } from '../scripts/lib/notice/guards.mjs'

// The longest text these tests allow.
const LIMIT = 5
// Where each fresh process loads the guards module from.
const guardsUrl = new URL('../scripts/lib/notice/guards.mjs', import.meta.url).href

test('a plain object is told apart from null, arrays and other values', () => {
	assert.equal(isPlainObject({}), true)
	assert.equal(isPlainObject({ a: 1 }), true)
	for (const value of [null, undefined, [], [1], 'text', 5, true]) assert.equal(isPlainObject(value), false)
})

test('a text within the limit is given back as it is', () => {
	assert.equal(readSafeText('hello', LIMIT), 'hello')
})

test('an empty text, a text over the limit and anything that is not text give undefined', () => {
	for (const value of ['', 'abcdef', undefined, null, 5, {}, ['a']]) {
		assert.equal(readSafeText(value, LIMIT), undefined, String(value))
	}
})

test('a control character or a line separator anywhere in the text gives undefined', () => {
	for (const code of [0x0a, 0x0d, 0x09, 0x1b, 0x07, 0x7f, 0x9b, 0x2028, 0x2029]) {
		assert.equal(readSafeText(`a${String.fromCodePoint(code)}b`, 10), undefined, `0x${code.toString(16)}`)
	}
})

// ---- claimNotice: at most one notice for each kind, session and start source ----

// The first run of the update notice, which is the one allowed to show.
const FIRST_RUN = { kind: 'update', input: { session_id: 's1', source: 'startup' } }

// guards.mjs finds its cache folder from HOME when loaded, so each case runs in a fresh process with its own HOME.
function inFakeHome(script) {
	const home = mkdtempSync(join(tmpdir(), 'ai-center-notice-test-'))
	try {
		const code = [
			`import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'`,
			`import { claimNotice } from ${JSON.stringify(guardsUrl)}`,
			`const dir = process.env.HOME + '/.cache/ai-center-hooks'`,
			`const FIRST_RUN = ${JSON.stringify(FIRST_RUN)}`,
			`const claim = (change = {}) => claimNotice({ ...FIRST_RUN, ...change })`,
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

test('the first run of a notice in a session may show it, and a second run may not', () => {
	assert.deepEqual(inFakeHome('console.log(JSON.stringify([claim(), claim(), claim()]))'), [true, false, false])
})

test('another session, another start source or another kind of notice may show it', () => {
	const result = inFakeHome(`
		console.log(JSON.stringify([
			claim(),
			claim({ input: { session_id: 's2', source: 'startup' } }),
			claim({ input: { session_id: 's1', source: 'resume' } }),
			claim({ kind: 'other' }),
		]))
	`)
	assert.deepEqual(result, [true, true, true, true])
})

test('a run without a session id may always show the notice, and leaves no marker', () => {
	const result = inFakeHome(`
		const results = []
		for (const input of [{}, { source: 'startup' }, { session_id: '' }]) {
			results.push(claim({ input }), claim({ input }))
		}
		console.log(JSON.stringify({ results, folderMade: existsSync(dir) }))
	`)
	assert.deepEqual(result, { results: [true, true, true, true, true, true], folderMade: false })
})

test('a marker file name shows nothing about the session', () => {
	const names = inFakeHome(`
		claim({ input: { session_id: 'my-secret-session', source: 'startup' } })
		console.log(JSON.stringify(readdirSync(dir)))
	`)
	assert.equal(names.length, 1)
	assert.match(names[0], /^notice-[0-9a-f]{64}$/)
})

test('a marker from a day ago is removed when a run claims, and a fresh one stays', () => {
	const result = inFakeHome(`
		mkdirSync(dir, { recursive: true })
		const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
		writeFileSync(dir + '/notice-old', '')
		utimesSync(dir + '/notice-old', old, old)
		writeFileSync(dir + '/notice-fresh', '')
		claim()
		console.log(JSON.stringify([existsSync(dir + '/notice-old'), existsSync(dir + '/notice-fresh')]))
	`)
	assert.deepEqual(result, [false, true])
})

test('the marker folder is made when it does not exist yet', () => {
	const result = inFakeHome('console.log(JSON.stringify({ shown: claim(), made: existsSync(dir) }))')
	assert.deepEqual(result, { shown: true, made: true })
})

test('a marker problem throws, so it is reported and the notice is not shown twice', () => {
	const result = inFakeHome(`
		mkdirSync(process.env.HOME + '/.cache', { recursive: true })
		writeFileSync(dir, '')
		let code
		try { claim() } catch (error) { code = error.code }
		console.log(JSON.stringify({ code }))
	`)
	assert.deepEqual(result, { code: 'EEXIST' })
})
