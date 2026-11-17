import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchJson } from '../connection/ai-center-mcp.mjs'
import { PLATFORM } from '../connection/client-connections.mjs'
import { isPlainObject, readSafeText } from './guards.mjs'

// Exactly three whole numbers with dots, so a prerelease or any other shape never causes a notice.
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
// The most characters the plugin name may have.
const NAME_LIMIT = 100
// The manifest with each client's plugin name and version.
export const MANIFEST_FILE = {
	[PLATFORM.claudeCode]: '.claude-plugin/plugin.json',
	[PLATFORM.codex]: '.codex-plugin/plugin.json',
}
// The client itself when it is listed, and any client that cannot be recognized reads the Claude manifest.
const resolveClient = (platform) => (Object.hasOwn(MANIFEST_FILE, platform) ? platform : PLATFORM.claudeCode)
// The plugin folder, three levels above this file.
const PLUGIN_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
// Where the backend publishes the latest release.
const RELEASE_ENDPOINT = '/api/client/hooks/latest'
// The name this request goes by in a failure record.
const RELEASE_OPERATION = 'release_latest'
// The most the check waits for the backend, which is also the most it can delay a Codex first prompt.
const RELEASE_TIMEOUT_MS = 2_000

export function parseVersion(text) {
	if (typeof text !== 'string') return undefined
	const match = VERSION_PATTERN.exec(text)
	if (!match) return undefined
	const parts = match.slice(1).map(Number)
	// Numbers too big to hold exactly are refused.
	if (!parts.every(Number.isSafeInteger)) return undefined
	const [major, minor, patch] = parts
	return { major, minor, patch }
}

// True only when both versions are understood and the installed one is older.
export function isOutdated(installed, latest) {
	const have = parseVersion(installed)
	const want = parseVersion(latest)
	if (!have || !want) return false
	for (const part of ['major', 'minor', 'patch']) {
		if (have[part] !== want[part]) return have[part] < want[part]
	}
	return false
}

// Rebuilds the release from only the known field and throws when it is wrong.
export function buildRelease(body) {
	const refuse = (problem) => new Error(`release answer refused: ${problem}`)
	if (!isPlainObject(body)) throw refuse('the answer is not a JSON object')
	if (!parseVersion(body.latest)) throw refuse('latest is not a supported version')
	return { latest: body.latest }
}

// The name and version from the running client's manifest.
export function readInstalledPlugin(platform, root = PLUGIN_ROOT) {
	const { name, version } = JSON.parse(readFileSync(join(root, MANIFEST_FILE[resolveClient(platform)]), 'utf8'))
	if (!readSafeText(name, NAME_LIMIT)) throw new Error('installed name is not supported')
	if (!parseVersion(version)) throw new Error(`installed version is not supported: ${JSON.stringify(version)}`)
	return { name, version }
}

// The backend's release answer, unchecked until buildRelease.
export const fetchLatestRelease = (connection) =>
	fetchJson(connection, { endpoint: RELEASE_ENDPOINT, operation: RELEASE_OPERATION, timeoutMs: RELEASE_TIMEOUT_MS })

// The notice text, or undefined when there is nothing to say, and any failure throws.
export async function checkForUpdate({ connection, platform, root }) {
	const { name, version: installed } = readInstalledPlugin(platform, root)
	const release = buildRelease(await fetchLatestRelease(connection))
	if (!isOutdated(installed, release.latest)) return undefined
	return formatNotice({ name, installed, release })
}

export function formatNotice({ name, installed, release }) {
	return `${name} hooks update available: installed ${installed}, latest ${release.latest}.`
}
