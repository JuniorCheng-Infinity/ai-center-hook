import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
	AiCenterError,
	LOOKUP_META_KEY,
	USAGE_META_KEY,
	callTool,
	callToolWithRequestId,
} from '../scripts/lib/connection/ai-center-mcp.mjs'

const connection = { baseUrl: 'http://mcp.test', apiKey: 'key' }

// The backend answers with one "data: <json>" line, and fetch is replaced so no network is touched.
async function callWithReply(reply) {
	const saved = globalThis.fetch
	globalThis.fetch = async () => ({ status: 200, text: async () => `data: ${JSON.stringify(reply)}\n\n` })
	try {
		return await callTool(connection, 'memory_add', {})
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
		callToolWithRequestId(connection, 'memory_add', { content: 'note' }, { usage: 'tool: Read', lookup }),
	)
	const { _meta, arguments: args } = sent[0].body.params
	assert.deepEqual(_meta[LOOKUP_META_KEY], lookup)
	assert.equal(_meta[USAGE_META_KEY], 'tool: Read')
	assert.deepEqual(args, { content: 'note' })
})

test('callTool still sends the usage and still returns only the result', async () => {
	const { returned, sent } = await callAndKeepRequests(() =>
		callTool(connection, 'memory_add', {}, undefined, 'tool: Bash'),
	)
	assert.deepEqual(returned, { content: [] })
	assert.equal(sent[0].body.params._meta[USAGE_META_KEY], 'tool: Bash')
})
