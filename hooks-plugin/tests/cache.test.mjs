import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cacheUrl = new URL('../scripts/lib/connection/cache.mjs', import.meta.url).href

// cache.mjs finds its folder from HOME when it is loaded, so each case runs in a fresh process with its own HOME.
function inFakeHome(script) {
	const home = mkdtempSync(join(tmpdir(), 'ai-center-cache-test-'))
	try {
		const code = [
			`import { readFileSync, readdirSync, writeFileSync } from 'node:fs'`,
			`import { readAddContentLimit, readProjectCache, writeProjectCache } from ${JSON.stringify(cacheUrl)}`,
			`const connection = { baseUrl: 'http://cache.test', apiKey: 'key' }`,
			`const dir = process.env.HOME + '/.cache/ai-center-hooks'`,
			`const overwrite = (text) => writeFileSync(dir + '/' + readdirSync(dir).find((name) => name.endsWith('.json')), text)`,
			`const show = () => console.log(JSON.stringify({ id: readProjectCache(connection), limit: readAddContentLimit(connection) }))`,
			script,
		].join('\n')
		const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
			env: { ...process.env, HOME: home },
			encoding: 'utf8',
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
	const read = inFakeHome(`writeProjectCache(connection, 1, 1); overwrite('{"projectId":"7","addContentMaxChars":-5}'); show()`)
	assert.deepEqual(read, {})
})

test('a damaged file reads as nothing and does not stop the hook', () => {
	const read = inFakeHome(`writeProjectCache(connection, 1, 1); overwrite('{not json'); show()`)
	assert.deepEqual(read, {})
})
