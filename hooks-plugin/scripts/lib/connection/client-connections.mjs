import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { readJsonFile, resolveDirs } from '../hook-utils.mjs'

// What each client calls itself. The backend maps these names to its client types, so they must not change.
export const PLATFORM = {
	claudeCode: 'claude-code',
	codex: 'codex-mcp-client'
}

// Read from the hook's environment (CLAUDECODE, or a .codex/ plugin root), which neither vendor documents.
export function detectPlatform() {
	if (process.env.CLAUDECODE) return PLATFORM.claudeCode
	const pluginRoot = process.env.PLUGIN_ROOT ?? process.env.CLAUDE_PLUGIN_ROOT ?? ''
	if (pluginRoot.includes('.codex/')) return PLATFORM.codex
	return undefined
}

// Finds the nearest ancestor (inclusive) containing `.git`, or undefined if `startDir` isn't inside a git repo at all.
function findRepoRoot(startDir) {
	let dir = startDir
	while (true) {
		if (existsSync(join(dir, '.git'))) return dir
		if (dir === homedir()) return undefined
		const parent = dirname(dir)
		if (parent === dir) return undefined
		dir = parent
	}
}

// Walks from `startDir` up to `boundary`, calling `check(dir)` at each level until one returns truthy.
function searchUpTo(startDir, boundary, check) {
	let dir = startDir
	while (true) {
		const result = check(dir)
		if (result) return result
		if (dir === boundary) return undefined
		dir = dirname(dir)
	}
}

// Climbing is only trusted inside a git repo, so a stray registration on a shared parent is never picked up.
export function findRegisteredAncestor(config, startDir) {
	const check = (dir) => config.projects?.[dir]?.mcpServers?.['ai-center']
	const repoRoot = findRepoRoot(startDir)
	if (!repoRoot) return check(startDir)
	return searchUpTo(startDir, repoRoot, check)
}

// The one place a stored MCP server entry becomes a connection, for both clients.
// The key may come with or without its "Bearer " prefix, and the short /mcp suffix and the old
// /api/client/mcp one give the same bare origin.
export function connectionFormatter(url, authorization) {
	const apiKey = typeof authorization === 'string' ? authorization.replace(/^Bearer\s+/i, '') : undefined
	if (typeof url !== 'string' || !url || !apiKey) return undefined
	return { baseUrl: url.replace(/\/(?:api\/client\/)?mcp\/?$/, ''), apiKey }
}

function readClaudeCodeConnection(cwd) {
	const config = readJsonFile(join(homedir(), '.claude.json'), undefined, '~/.claude.json failed to read')
	if (!config) return undefined
	const server = findRegisteredAncestor(config, cwd)
	return connectionFormatter(server?.url, server?.headers?.Authorization)
}

// Reads one config.toml path's [mcp_servers.ai-center] table, or undefined.
function readServerFromConfigToml(configPath) {
	if (!existsSync(configPath)) return undefined
	const result = spawnSync('python3', ['-c',
		'import json,sys,tomllib; ' +
		'print(json.dumps(tomllib.load(open(sys.argv[1], "rb")).get("mcp_servers", {}).get("ai-center", {})))',
		configPath], { encoding: 'utf8', timeout: 5000 })
	if (result.status !== 0) return undefined
	const server = JSON.parse(result.stdout)
	return Object.keys(server).length ? server : undefined
}

// Codex can name an environment variable that holds the key instead of writing the header out.
function serverToConnection(server) {
	const authorization = server.bearer_token_env_var
		? process.env[server.bearer_token_env_var]
		: server.http_headers?.Authorization
	return connectionFormatter(server.url, authorization)
}

// Removes the [mcp_servers.ai-center] table and its sub-tables from raw TOML and leaves the rest untouched.
function stripExistingAiCenterSection(text) {
	const kept = []
	let skipping = false
	for (const line of text.split('\n')) {
		const header = /^\[([^\]]+)\]/.exec(line.trim())
		if (header) {
			skipping = header[1] === 'mcp_servers.ai-center' || header[1].startsWith('mcp_servers.ai-center.')
		}
		if (!skipping) kept.push(line)
	}
	return kept.join('\n')
}

// Merges the [mcp_servers.ai-center] table into <dir>/.codex/config.toml, which Codex prefers over the global file.
export function writeCodexProjectConnection(dir, { baseUrl, apiKey }) {
	const configPath = join(dir, '.codex', 'config.toml')
	mkdirSync(join(dir, '.codex'), { recursive: true })
	const existing = existsSync(configPath) ? readFileSync(configPath, 'utf8') : ''
	const withoutOldSection = stripExistingAiCenterSection(existing).replace(/\n+$/, '')
	const section = [
		'[mcp_servers.ai-center]',
		`url = "${baseUrl.replace(/\/$/, '')}/mcp"`,
		'',
		'[mcp_servers.ai-center.http_headers]',
		`Authorization = "Bearer ${apiKey}"`,
		'',
	].join('\n')
	writeFileSync(configPath, withoutOldSection ? `${withoutOldSection}\n\n${section}` : section)
	return configPath
}

// The project-local config.toml is bounded by .git and wins over the global file.
function readCodexConnection(dir) {
	const check = (level) => readServerFromConfigToml(join(level, '.codex', 'config.toml'))
	const repoRoot = findRepoRoot(dir)
	const projectServer = repoRoot ? searchUpTo(dir, repoRoot, check) : check(dir)
	const globalConfigPath = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml')
	const server = projectServer ?? readServerFromConfigToml(globalConfigPath)
	throw new Error(
		`check ${check} \n` +
		// `searchUpTo(dir, repoRoot, check) ${searchUpTo(dir, repoRoot, check)} \n` +
		`check(dir) ${check(dir)} \n` +
		`repoRoot ${repoRoot} \n` +
		`projectServer ${projectServer} \n` +
		`globalConfigPath ${globalConfigPath} \n` +
		`server ${server}`
	)
	return server && serverToConnection(server)
}

function readConnectionForPlatform(platform, { cwd, projectDir }) {
	if (platform === PLATFORM.claudeCode) {
		return readClaudeCodeConnection(projectDir) ?? (cwd !== projectDir ? readClaudeCodeConnection(cwd) : undefined)
	}
	if (platform === PLATFORM.codex) {
		return readCodexConnection(projectDir) ?? (cwd !== projectDir ? readCodexConnection(cwd) : undefined)
	}
	return (
		readCodexConnection(projectDir) ??
		readClaudeCodeConnection(projectDir) ??
		(cwd !== projectDir ? readCodexConnection(cwd) ?? readClaudeCodeConnection(cwd) : undefined)
	)
}

export function resolveConnection({ cwd, projectDir }) {
	const envBaseUrl = process.env.AI_CENTER_BASE_URL
	const envApiKey = process.env.AI_CENTER_API_KEY
	if (envBaseUrl && envApiKey) return { baseUrl: envBaseUrl.replace(/\/$/, ''), apiKey: envApiKey }

	const discovered = readConnectionForPlatform(detectPlatform(), { cwd, projectDir })
	if (discovered) return discovered

	throw new Error(
		`cwd ${cwd}` +
		`projectDir ${projectDir}` +
		`detectPlatform() ${detectPlatform()}` +
		'ai-center connection not found: set AI_CENTER_BASE_URL and AI_CENTER_API_KEY, ' +
		'or configure ai-center in Codex config.toml (requires Python 3.11+) or Claude Code',
	)
}

// How a hook finds its connection: the directories come from the hook's own input.
export function resolveHookConnection(input) {
	return resolveConnection(resolveDirs(input))
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const baseUrl = process.env.AI_CENTER_BASE_URL
	const apiKey = process.env.AI_CENTER_API_KEY

	if (!baseUrl || !apiKey) {
		console.error('Set AI_CENTER_BASE_URL and AI_CENTER_API_KEY first.')
		process.exit(1)
	}
	console.log(writeCodexProjectConnection(process.cwd(), { baseUrl, apiKey }))
}
