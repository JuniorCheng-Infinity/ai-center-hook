import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
	AiCenterError,
	LOOKUP_META_KEY,
	USAGE_META_KEY,
	callTool,
	callToolWithRequestId,
	fetchJson,
} from '../scripts/lib/connection/ai-center-mcp.mjs'
import { textReply, withFakeFetch } from './fake-ai-center.mjs'

const connection = { baseUrl: 'http://mcp.test', apiKey: 'key' }

// The backend answers with one "data: <json>" line, and fetch is replaced so no network is touched.
async function callWithReply(reply) {
	const saved = globalThis.fetch
	globalThis.fetch = async () => ({ status: 200, text: async () => `data: ${JSON.stringify(reply)}\n\n` })
	try {
		return await callTool(connection, 'document_add', {})
	} finally {
		globalThis.fetch = saved
	}
}

const rejectsWith = (reply, message) =>
	assert.rejects(callWithReply(reply), (error) => error instanceof AiCenterError && error.message === message)

test('a successful tool call returns its result', async () => {
	const result = await callWithReply({ result: { content: [{ type: 'text', text: 'ok' }] } })
	assert.deepEqual(result, { content: [{ type: 'text', text: 'ok' }] })
})

test('a tool error shows the text the tool gave', async () => {
	await rejectsWith(
		{ result: { isError: true, content: [{ type: 'text', text: 'Not allowed' }] } },
		'tool error: Not allowed',
	)
})

test('blocks without text are left out of a tool error', async () => {
	await rejectsWith(
		{ result: { isError: true, content: [{ type: 'image' }, { type: 'text', text: 'boom' }, null] } },
		'tool error: boom',
	)
})

test('a tool error without any text says so, instead of printing undefined', async () => {
	await rejectsWith({ result: { isError: true } }, 'tool error: no details')
	await rejectsWith({ result: { isError: true, content: [{ type: 'image' }] } }, 'tool error: no details')
})

test('a JSON-RPC error shows its message', async () => {
	await rejectsWith({ error: { message: 'Invalid request' } }, 'Invalid request')
})

// fetch is replaced and keeps what it was asked to send, so a test can read the request id and the _meta.
async function callAndKeepRequests(makeCalls) {
	const saved = globalThis.fetch
	const sent = []
	globalThis.fetch = async (_url, options) => {
		sent.push({ headers: options.headers, body: JSON.parse(options.body) })
		return { status: 200, text: async () => `data: ${JSON.stringify({ result: { content: [] } })}\n\n` }
	}
	try {
		return { returned: await makeCalls(), sent }
	} finally {
		globalThis.fetch = saved
	}
}

test('callToolWithRequestId returns the result and the request id the backend logged', async () => {
	const { returned, sent } = await callAndKeepRequests(() =>
		callToolWithRequestId(connection, 'memory_search', { query: 'q' }),
	)
	assert.deepEqual(returned.result, { content: [] })
	assert.equal(returned.requestId, sent[0].headers['x-request-id'])
})

test('every call gets its own request id', async () => {
	const { returned } = await callAndKeepRequests(async () => [
		await callToolWithRequestId(connection, 'memory_search', {}),
		await callToolWithRequestId(connection, 'memory_search', {}),
	])
	assert.notEqual(returned[0].requestId, returned[1].requestId)
})

test('the lookup record rides in _meta next to the usage, and never in the arguments', async () => {
	const lookup = { searchRequestId: 'search-1', decision: 'add', reason: 'no match found', selectedId: null }
	const { sent } = await callAndKeepRequests(() =>
		callToolWithRequestId(connection, 'document_add', { content: 'note' }, { usage: 'tool: Read', lookup }),
	)
	const { _meta, arguments: args } = sent[0].body.params
	assert.deepEqual(_meta[LOOKUP_META_KEY], lookup)
	assert.equal(_meta[USAGE_META_KEY], 'tool: Read')
	assert.deepEqual(args, { content: 'note' })
})

test('callTool still sends the usage and still returns only the result', async () => {
	const { returned, sent } = await callAndKeepRequests(() =>
		callTool(connection, 'document_add', {}, undefined, 'tool: Bash'),
	)
	assert.deepEqual(returned, { content: [] })
	assert.equal(sent[0].body.params._meta[USAGE_META_KEY], 'tool: Bash')
})

// ---- fetchJson: one GET that gives back JSON ----

// A key no other text contains, so a test can prove it never leaks.
const SECRET_CONNECTION = { baseUrl: 'http://mcp.test', apiKey: 'secret-key-abc123' }
const GET_OPTIONS = { endpoint: '/api/client/hooks/latest', operation: 'release_latest', timeoutMs: 1_000 }

const getWith = (reply) => withFakeFetch(reply, () => fetchJson(SECRET_CONNECTION, GET_OPTIONS))

test('fetchJson sends one GET with the key only in the Authorization header, and gives back the JSON', async () => {
	const { result, sent } = await getWith(textReply(200, '{"latest":"0.2.0"}'))
	assert.deepEqual(result, { latest: '0.2.0' })
	assert.equal(sent.length, 1)
	const { url, options } = sent[0]
	assert.equal(url, 'http://mcp.test/api/client/hooks/latest')
	assert.equal(options.method, 'GET')
	assert.equal(options.body, undefined)
	assert.equal(options.headers.Authorization, `Bearer ${SECRET_CONNECTION.apiKey}`)
	assert.ok(!url.includes(SECRET_CONNECTION.apiKey))
	for (const [name, value] of Object.entries(options.headers)) {
		if (name !== 'Authorization') assert.ok(!String(value).includes(SECRET_CONNECTION.apiKey), name)
	}
})

test('fetchJson sends a request id and a time limit', async () => {
	const { sent } = await getWith(textReply(200, '{}'))
	assert.match(sent[0].options.headers['x-request-id'], /^[0-9a-f-]{36}$/)
	assert.ok(sent[0].options.signal instanceof AbortSignal)
})

test('an HTTP error names the status, endpoint, method, operation and request id', async () => {
	for (const status of [401, 403, 404, 500, 502]) {
		const { error, sent } = await getWith(textReply(status, '{"error":"nope"}'))
		assert.ok(error instanceof AiCenterError, String(status))
		assert.equal(error.statusCode, status)
		assert.equal(error.message, 'nope')
		assert.equal(error.operation, 'release_latest')
		assert.equal(error.endpoint, '/api/client/hooks/latest')
		assert.equal(error.method, 'GET')
		assert.equal(error.requestId, sent[0].options.headers['x-request-id'])
		assert.equal(typeof error.latencyMs, 'number')
	}
})

test('an answer that is not JSON is an error, and a page of HTML gives a plain reason', async () => {
	const notJson = await getWith(textReply(200, 'not json'))
	assert.ok(notJson.error instanceof AiCenterError)
	assert.equal(notJson.error.statusCode, 200)
	assert.match(notJson.error.message, /not JSON/)
	const page = await getWith(textReply(502, '<html>Bad Gateway</html>'))
	assert.equal(page.error.message, 'invalid format')
})

test('an offline backend and a timeout each give their own reason', async () => {
	const offline = await getWith(() => {
		throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })
	})
	assert.equal(offline.error.message, 'unreachable (ENOTFOUND)')
	const slow = await getWith(() => {
		throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
	})
	assert.equal(slow.error.message, 'timeout after 1s')
	for (const { error } of [offline, slow]) assert.equal(error.statusCode, null)
})

test('the key is in no error, whatever went wrong', async () => {
	const failures = [
		textReply(401, '{"error":"nope"}'),
		textReply(200, 'not json'),
		() => {
			throw new TypeError('fetch failed')
		},
	]
	for (const reply of failures) {
		const { error } = await getWith(reply)
		assert.ok(error instanceof AiCenterError)
		assert.ok(!`${error.message} ${JSON.stringify(error)}`.includes(SECRET_CONNECTION.apiKey))
	}
})

test('an MCP call that fails still names the MCP endpoint and the POST method', async () => {
	const saved = globalThis.fetch
	globalThis.fetch = async () => {
		throw new TypeError('fetch failed')
	}
	try {
		await assert.rejects(callTool(connection, 'document_add', {}), (error) =>
			error instanceof AiCenterError && error.endpoint === '/api/client/mcp' && error.method === 'POST')
	} finally {
		globalThis.fetch = saved
	}
})
