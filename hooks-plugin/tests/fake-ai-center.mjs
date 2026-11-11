import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve('hooks-plugin')

// These texts are the ones the backend answers with.
export const FAKE_ERRORS = {
	noPermission: 'You do not have permission to do this in this project. Do not retry.',
	documentNotFound: 'Document not found. Check document_id (the id document_add returned), then retry.',
	unexpected:
		'Unexpected error. If you were saving or changing a memory, search first to check whether it went through, ' +
		'then retry once. Report this requestId if it fails again.',
}

// FETCH_MODE picks the behavior of the fake server and every request is appended to TEST_CALLS.
const FAKE_FETCH = `import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
const errors = ${JSON.stringify(FAKE_ERRORS)}
const fromEnv = (name, fallback) => (process.env[name] ? JSON.parse(process.env[name]) : fallback)
// The list answers like the real one: newest first by the asked sort, and without the text of a document.
const listDocuments = (args) => {
	const field = args.sort ?? 'createdAt'
	return fromEnv('FAKE_DOCUMENTS', [])
		.map((document, position) => ({ document, position }))
		.sort((a, b) => b.document.system[field].localeCompare(a.document.system[field]) || a.position - b.position)
		.slice(0, args.limit ?? 10)
		.map(({ document: { content, ...listed } }) => listed)
}
const toolReply = (tool, args) => {
	if (tool === 'document_add' || tool === 'document_update') return { id: randomUUID() }
	if (tool === 'memory_search') return fromEnv('FAKE_SEARCH_RESULTS', [])
	if (tool === 'get_me') return fromEnv('FAKE_ME', { user: { id: 11 }, key: { id: 3 } })
	if (tool === 'profile_get') {
		return { statusCode: 200, message: '', profile: fromEnv('FAKE_PROFILE', { static: [], dynamic: [], buckets: {} }) }
	}
	if (tool === 'document_list') {
		return { statusCode: 200, message: '', documents: listDocuments(args), chunks: [], memories: [] }
	}
	if (tool === 'document_get') {
		const found = fromEnv('FAKE_DOCUMENTS', []).find((document) => document.id === args.document_id)
		return found && { statusCode: 200, message: '', ...found, memories: [] }
	}
	return {}
}
globalThis.fetch = async (url, options) => {
	const body = JSON.parse(options.body)
	const tool = body.params?.name
	const args = body.params?.arguments ?? {}
	const saved = toolReply(tool, args)
	const record = { ...body, headers: options.headers, returned: saved?.id }
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
	if (tool === 'document_update' && mode === 'update-not-found') return memoryError(404, errors.documentNotFound)
	if (tool === 'document_get' && args.document_id === process.env.FAKE_FAIL_ID) return memoryError(500, errors.unexpected)
	if (tool === 'document_get' && !saved) return memoryError(404, errors.documentNotFound)
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
			? { tools: [{ name: 'document_add', inputSchema: addSchema }] }
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

	// "context.mjs rules" names the script and the argument its command ends with.
	function findHandler(script) {
		const [file, ...args] = script.split(' ')
		return Object.values(config.hooks).flat().flatMap((group) => group.hooks).find((hook) =>
			hook.command.includes(`/scripts/${file}`) && (args.length === 0 || hook.command.endsWith(` ${args.join(' ')}`)))
	}

	// Runs one script by hand, for the cases hooks.json can never produce, such as a wrong argument.
	function runScript(file, args, input) {
		const result = spawnSync(process.execPath, [join(root, 'scripts', file), ...args], {
			input: JSON.stringify({ session_id: 'test-session', ...input }),
			env: { ...env, FETCH_MODE: '' },
			encoding: 'utf8',
		})
		assert.equal(result.error, undefined)
		assert.equal(result.status, 0)
		return result
	}

	function run(script, input, mode = '', extraEnv = {}) {
		const handler = findHandler(script)
		assert.ok(handler, `no hook is configured for ${script}`)
		const result = spawnSync(handler.command, {
			shell: true,
			input: JSON.stringify({ session_id: 'test-session', ...input }),
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
		const cacheDir = join(dir, '.cache', 'ai-center-hooks')
		const file = existsSync(cacheDir) ? readdirSync(cacheDir).find((name) => name.startsWith('turn-notes-')) : undefined
		const text = file ? readCacheFile(file) : undefined
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

	// The memory writes only: a hook may read first, and a test about what was saved does not care how.
	const READ_TOOLS = ['memory_search', 'get_me', 'profile_get', 'document_list', 'document_get']
	const writeCalls = () => toolCalls().filter((call) => !READ_TOOLS.includes(call.name))

	return {
		dir,
		run,
		runScript,
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
