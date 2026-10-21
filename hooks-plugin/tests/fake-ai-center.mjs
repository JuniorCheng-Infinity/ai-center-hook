import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve('hooks-plugin')

// These texts are the ones the backend answers with.
export const FAKE_ERRORS = {
	noPermission: 'You do not have permission to do this in this project. Do not retry.',
	memoryNotFound: 'Memory not found. Search again to get its current id, then retry.',
	unexpected:
		'Unexpected error. If you were saving or changing a memory, search first to check whether it went through, ' +
		'then retry once. Report this requestId if it fails again.',
}

// FETCH_MODE picks the behavior of the fake server and every request is appended to TEST_CALLS.
const FAKE_FETCH = `import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
const errors = ${JSON.stringify(FAKE_ERRORS)}
globalThis.fetch = async (url, options) => {
	const body = JSON.parse(options.body)
	const tool = body.params?.name
	const saved = tool === 'memory_add' || tool === 'memory_update' ? { id: randomUUID() }
		: tool === 'memory_search' ? JSON.parse(process.env.FAKE_SEARCH_RESULTS ?? '[]') : {}
	const record = { ...body, headers: options.headers, returned: saved.id }
	appendFileSync(process.env.TEST_CALLS, JSON.stringify(record) + '\\n')
	const mode = process.env.FETCH_MODE
	const reply = (status, text) => ({ status, text: async () => text })
	const memoryError = (status, message) =>
		reply(status, JSON.stringify({ statusCode: status, message, requestId: options.headers['x-request-id'] }))
	if (mode === 'unreachable') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
	if (mode === 'timeout') throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
	if (mode === 'http-401') return reply(401, '{"error":"unauthorized"}')
	if (mode === 'bad-gateway') return reply(502, '<html>Bad Gateway</html>')
	if (mode === 'rpc-error') return reply(200, 'data: {"error":{"message":"Invalid request"}}\\n\\n')
	if (mode === 'bad-data-line') return reply(200, 'data: not json\\n\\n')
	if (tool && mode === 'tool-error') return memoryError(403, errors.noPermission)
	if (tool === 'memory_update' && mode === 'update-not-found') return memoryError(404, errors.memoryNotFound)
	if (tool === 'memory_search' && mode === 'search-error') return memoryError(500, errors.unexpected)
	if (tool && mode === 'server-error') return memoryError(500, errors.unexpected)
	if (body.method === 'tools/list' && mode === 'tools-list-error') {
		return reply(200, 'data: {"error":{"message":"Method not found"}}\\n\\n')
	}
	const addSchema = {
		type: 'object',
		properties: { content: { type: 'string', maxLength: Number(process.env.FAKE_ADD_LIMIT || 10000) } },
	}
	const result = body.method === 'initialize'
		? { instructions: '- Test (project_id: 42)' }
		: body.method === 'tools/list'
			? { tools: [{ name: 'memory_add', inputSchema: addSchema }] }
			: { content: [{ type: 'text', text: JSON.stringify(saved) }] }
	return reply(200, 'data: ' + JSON.stringify({ result }) + '\\n\\n')
}`

export function writeFakeFetch(dir) {
	const preload = join(dir, 'fetch.mjs')
	writeFileSync(preload, FAKE_FETCH)
	return preload
}

// The real hook scripts run against the fake server with a throwaway home folder, so nothing real is touched.
export function setupHookRun() {
	const dir = mkdtempSync(join(tmpdir(), 'ai-center-hooks-test-'))
	const calls = join(dir, 'calls.jsonl')
	const preload = writeFakeFetch(dir)
	const config = JSON.parse(readFileSync(join(root, 'hooks/hooks.json')))
	const env = {
		...process.env,
		HOME: dir,
		CLAUDE_PLUGIN_ROOT: root,
		AI_CENTER_BASE_URL: 'http://test.invalid',
		AI_CENTER_API_KEY: 'test-key',
		TEST_CALLS: calls,
		NODE_OPTIONS: `--import=${preload}`,
	}

	function run(script, input, mode = '', extraEnv = {}) {
		const handler = Object.values(config.hooks).flat().flatMap((group) => group.hooks)
			.find((hook) => hook.command.includes(`/scripts/${script}`))
		assert.ok(handler, `no hook is configured for ${script}`)
		const result = spawnSync(handler.command, {
			shell: true,
			input: JSON.stringify(input),
			env: { ...env, FETCH_MODE: mode, ...extraEnv },
			encoding: 'utf8',
		})
		assert.equal(result.error, undefined)
		assert.equal(result.status, 0)
		return result
	}

	const message = (result) => (result.stdout ? JSON.parse(result.stdout).systemMessage : undefined)
	const readCacheFile = (name) => {
		const path = join(dir, '.cache', 'ai-center-hooks', name)
		return existsSync(path) ? readFileSync(path, 'utf8') : undefined
	}
	// The cache file is named after a hash of the connection, the same way cache.mjs names it.
	const projectCache = () => {
		const key = createHash('sha256').update(`${env.AI_CENTER_BASE_URL}|${env.AI_CENTER_API_KEY}`).digest('hex')
		const text = readCacheFile(`${key}.json`)
		return text ? JSON.parse(text) : undefined
	}
	const failures = () => (readCacheFile('failures.jsonl') ?? '').trim().split('\n').filter(Boolean).map(JSON.parse)
	const turnNoteIds = () => {
		const text = readCacheFile('turn-notes.json')
		return text ? JSON.parse(text) : undefined
	}
	const sentRequests = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse) : [])
	const toolCalls = () => sentRequests()
		.filter((request) => request.method === 'tools/call')
		.map((request) => ({
			name: request.params.name,
			arguments: request.params.arguments,
			returned: request.returned,
		}))

	// The memory writes only: a hook may search first, and a test about what was saved does not care how.
	const writeCalls = () => toolCalls().filter((call) => call.name !== 'memory_search')

	return {
		dir,
		run,
		message,
		failures,
		projectCache,
		turnNoteIds,
		sentRequests,
		toolCalls,
		writeCalls,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	}
}
