// Connection discovery lives in client-connections.mjs and stdin plumbing in hook-utils.mjs.

import { randomUUID } from 'node:crypto'
import { readProjectCache, writeProjectCache } from './cache.mjs'
import { detectPlatform } from './client-connections.mjs'
import { errorMessage, logWarning, parseJson } from '../hook-utils.mjs'

const PROTOCOL_VERSION = '2025-06-18'
const MCP_ENDPOINT = '/api/client/mcp'
const REQUEST_TIMEOUT_MS = 8_000
// Optional lookup: kept short so SessionStart (initialize, this, memory_search) stays inside its own timeout.
const LIMIT_LOOKUP_TIMEOUT_MS = 3_000
const DATA_LINE_PREFIX = 'data: '

export class AiCenterError extends Error {
	constructor({ operation, statusCode, requestId, latencyMs, info }) {
		super(info)
		this.name = 'AiCenterError'
		this.operation = operation
		this.endpoint = MCP_ENDPOINT
		this.method = 'POST'
		this.statusCode = statusCode
		this.requestId = requestId
		this.latencyMs = latencyMs
	}
}

// Memory tools answer { message } and the app's own errors answer { error }, both as plain JSON.
function readErrorInfo(text) {
	const body = parseJson(text)
	const info = body?.message ?? body?.error
	return typeof info === 'string' && info ? info : 'invalid format'
}

// The request id is the backend's request_id in its log, so a caller that needs it later can choose it up front.
async function sendJsonRpc(connection, body, timeoutMs = REQUEST_TIMEOUT_MS, requestId = randomUUID()) {
	const operation = body.method === 'tools/call' ? body.params.name : body.method
	const startedAt = Date.now()
	const rpcError = (info, statusCode = null) =>
		new AiCenterError({ operation, statusCode, requestId, latencyMs: Date.now() - startedAt, info })

	let response
	let text
	try {
		response = await fetch(`${connection.baseUrl}${MCP_ENDPOINT}`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream',
				Authorization: `Bearer ${connection.apiKey}`,
				'x-request-id': requestId,
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		})
		text = await response.text()
	} catch (error) {
		const info = error?.name === 'TimeoutError'
			? `timeout after ${timeoutMs / 1000}s`
			: `unreachable (${error?.cause?.code ?? error?.cause?.message ?? errorMessage(error)})`
		throw rpcError(info)
	}

	const dataLine = text.split('\n').find((line) => line.startsWith(DATA_LINE_PREFIX))
	if (!dataLine) throw rpcError(readErrorInfo(text), response.status)
	const dataText = dataLine.slice(DATA_LINE_PREFIX.length)
	const reply = parseJson(dataText)
	if (!reply) throw rpcError(readErrorInfo(dataText), response.status)
	if (reply.error) throw rpcError(reply.error.message ?? JSON.stringify(reply.error), response.status)
	if (reply.result?.isError) {
		// Only blocks that carry text are shown, and an error with none says so instead of printing "undefined".
		const texts = (reply.result.content ?? [])
			.map((block) => block?.text)
			.filter((text) => typeof text === 'string' && text.length > 0)
		throw rpcError(`tool error: ${texts.join(' ') || 'no details'}`, response.status)
	}
	return reply.result
}

async function initialize(connection) {
	return sendJsonRpc(connection, {
		jsonrpc: '2.0',
		id: 1,
		method: 'initialize',
		params: {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: detectPlatform() ?? 'ai-center-hooks-plugin', version: '0.1.0' },
		},
	})
}

// The tools, skills and MCP tools of a turn, for the request monitor only. It rides in _meta, which the memory tools
// never read, so it is not saved to Supermemory and has no length limit. The backend reads the same key.
export const USAGE_META_KEY = 'ai-center/usage'

// What the hook decided for a note, and the request id of the search it decided from. Like the usage, it is for the
// request monitor only.
export const LOOKUP_META_KEY = 'ai-center/lookup'

// Gives back the request id the backend logged for this call, so a later call can point back to it.
export async function callToolWithRequestId(connection, name, args, { timeoutMs, usage, lookup } = {}) {
	// Only tools/call is logged by the backend, so the platform name, the usage and the lookup ride on it through _meta.
	const platform = detectPlatform()
	const meta = {
		...(platform ? { 'io.modelcontextprotocol/clientInfo': { name: platform } } : {}),
		...(usage ? { [USAGE_META_KEY]: usage } : {}),
		...(lookup ? { [LOOKUP_META_KEY]: lookup } : {}),
	}
	const requestId = randomUUID()
	const result = await sendJsonRpc(
		connection,
		{
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/call',
			params: {
				name,
				arguments: args,
				...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
			},
		},
		timeoutMs,
		requestId,
	)
	return { result, requestId }
}

export async function callTool(connection, name, args, timeoutMs, usage) {
	return (await callToolWithRequestId(connection, name, args, { timeoutMs, usage })).result
}

// The line format must match the one the backend writes in its instructions text.
function parseAccessibleProjects(instructions) {
	const matches = [...(instructions ?? '').matchAll(/^- (.+?) \(project_id: (\d+)\)/gm)]
	return matches.map((match) => ({ name: match[1], id: Number(match[2]) }))
}

// A user has at most one project.
function resolveProjectFromInstructions(instructions) {
	const projects = parseAccessibleProjects(instructions)
	if (projects.length === 1) return projects[0]
	throw new Error('ai-center: this connection has no project access — ask an admin to grant this user a project')
}

// The backend builds this tool schema from its own config, so the hook never hardcodes the limit.
async function fetchAddContentLimit(connection) {
	const result = await sendJsonRpc(
		connection,
		{ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
		LIMIT_LOOKUP_TIMEOUT_MS,
	)
	const addTool = result.tools?.find((tool) => tool.name === 'memory_add')
	const maxLength = addTool?.inputSchema?.properties?.content?.maxLength
	return Number.isInteger(maxLength) && maxLength > 0 ? maxLength : undefined
}

// Only SessionStart may call this, so the cache is refreshed once per session.
export async function resolveAndCacheProject(connection) {
	const init = await initialize(connection)
	const project = resolveProjectFromInstructions(init.instructions)
	// A missing limit is not fatal: callers fall back to the backend's default.
	const addContentMaxChars = await fetchAddContentLimit(connection).catch((error) => {
		logWarning('memory_add limit lookup failed', error)
	})
	writeProjectCache(connection, project.id, addContentMaxChars)
	return project
}

export async function resolveProjectId(connection) {
	const cached = readProjectCache(connection)
	if (cached !== undefined) return cached
	return (await resolveAndCacheProject(connection)).id
}
