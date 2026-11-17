import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AiCenterError } from '../scripts/lib/connection/ai-center-mcp.mjs'
import { PLATFORM } from '../scripts/lib/connection/client-connections.mjs'
import {
	MANIFEST_FILE, buildRelease, checkForUpdate, fetchLatestRelease, formatNotice, isOutdated, parseVersion,
	readInstalledPlugin,
} from '../scripts/lib/notice/update.mjs'
import { textReply, withFakeFetch } from './fake-ai-center.mjs'

// The release answer as the backend sends it.
const RELEASE_BODY = { latest: '0.2.0' }
const withChange = (change) => ({ ...RELEASE_BODY, ...change })
const buildTestRelease = () => buildRelease(RELEASE_BODY)
// The plugin name that the test manifests carry.
const PLUGIN_NAME = 'example-plugin'

// Versions the rules refuse: a prerelease, a build tag, a missing or extra part, a "v" prefix, a leading zero,
// spaces, a line break at the end, a number too big to compare exactly, and anything that is not text.
// None of them may ever cause a notice.
const UNSUPPORTED_VERSIONS = [
	'0.2.0-beta.1', '0.2.0+build5', '1.2', '1.2.3.4', 'v1.2.3', '01.2.3', ' 1.2.3', '0.2.0\n', '1.2.x',
	'latest', '', '99999999999999999999.0.0', undefined, null, 5, {},
]
// The most characters the plugin name may have.
const NAME_LIMIT = 100
// A line break, an escape (it can move the cursor or recolor the screen), a bell, DEL, a C1 control and the
// Unicode line and paragraph separators, none of which may be in the plugin name.
const CONTROL_CHARACTERS = [
	'\n', '\r', '\t', '\u001b[31m', '\u0007', '\u007f', '\u009b',
	String.fromCodePoint(0x2028), String.fromCodePoint(0x2029),
]

// ---- version rules ----

test('an older installed version is outdated', () => {
	assert.equal(isOutdated('0.1.0', '0.2.0'), true)
})

test('the same version is not outdated', () => {
	assert.equal(isOutdated('0.2.0', '0.2.0'), false)
})

test('a newer installed version is never outdated, so there is no downgrade notice', () => {
	for (const installed of ['0.2.1', '0.3.0', '1.0.0']) {
		assert.equal(isOutdated(installed, '0.2.0'), false, installed)
	}
})

test('versions are compared as numbers, not as text', () => {
	assert.equal(isOutdated('0.9.0', '0.10.0'), true)
	assert.equal(isOutdated('0.10.0', '0.9.0'), false)
	assert.equal(isOutdated('1.9.9', '1.10.0'), true)
	assert.equal(isOutdated('2.0.0', '10.0.0'), true)
})

test('a supported version is read as three numbers', () => {
	assert.deepEqual(parseVersion('0.10.3'), { major: 0, minor: 10, patch: 3 })
})

test('a version the rules do not support is not understood', () => {
	for (const version of UNSUPPORTED_VERSIONS) {
		assert.equal(parseVersion(version), undefined, String(version))
	}
})

test('an unsupported version on either side never gives a notice', () => {
	for (const version of UNSUPPORTED_VERSIONS) {
		assert.equal(isOutdated(version, '0.2.0'), false, `installed ${String(version)}`)
		assert.equal(isOutdated('0.1.0', version), false, `latest ${String(version)}`)
	}
})

// ---- the release answer ----

test('a complete release answer is accepted', () => {
	assert.deepEqual(buildRelease(RELEASE_BODY), RELEASE_BODY)
})

test('unexpected fields are dropped, and nothing is run or merged into the release', () => {
	const text = '{"latest":"0.2.0","notes":"n","instructions":{"other":"a"},' +
		'"command":"touch /tmp/x","__proto__":{"polluted":true}}'
	const release = buildRelease(JSON.parse(text))
	assert.deepEqual(Object.keys(release), ['latest'])
	assert.equal(Object.getPrototypeOf(release), Object.prototype)
	assert.equal(release.polluted, undefined)
	assert.equal({}.polluted, undefined)
})

test('an answer that is not an object is refused, and the reason says so', () => {
	for (const body of [undefined, null, 'text', 42, [], [RELEASE_BODY]]) {
		assert.throws(() => buildRelease(body), /release answer refused: .*not a JSON object/)
	}
})

test('an answer with a missing or wrong latest version is refused, and the reason names the field', () => {
	for (const latest of ['0.2.0-beta.1', undefined, 2, '', 'latest']) {
		assert.throws(() => buildRelease(withChange({ latest })), /release answer refused: latest/, String(latest))
	}
	assert.throws(() => buildRelease({}), /latest/)
})

test('the reason never repeats the text of the answer', () => {
	const text = 'SECRET-TEXT-IN-ANSWER'
	for (const change of [{ latest: text }, { latest: `${text}\n` }]) {
		assert.throws(() => buildRelease(withChange(change)), (error) => !error.message.includes(text))
	}
})

// ---- the notice text ----

const formatExpectedNotice = () => `${PLUGIN_NAME} hooks update available: installed 0.1.0, latest 0.2.0.`

test('the notice is one line with the plugin name, the installed version and the latest version', () => {
	const notice = formatNotice({ name: PLUGIN_NAME, installed: '0.1.0', release: buildTestRelease() })
	assert.equal(notice, formatExpectedNotice())
	assert.ok(!notice.includes('\n'))
})

// ---- the installed plugin ----

// A plugin folder holding the manifests given, each saying its own version, so a test can tell which one was read.
function makePluginFolder(manifests) {
	const root = mkdtempSync(join(tmpdir(), 'notice-update-'))
	for (const [folder, manifest] of Object.entries(manifests)) {
		mkdirSync(join(root, folder))
		writeFileSync(join(root, folder, 'plugin.json'), JSON.stringify(manifest))
	}
	return root
}

function withPluginFolder(manifests, body) {
	const root = makePluginFolder(manifests)
	try {
		body(root)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
}

test('the name and version come from the manifest of the client that is running', () => {
	const manifests = {
		'.claude-plugin': { name: 'claude-plugin', version: '0.3.0' },
		'.codex-plugin': { name: 'codex-plugin', version: '0.4.0' },
	}
	withPluginFolder(manifests, (root) => {
		assert.deepEqual(readInstalledPlugin(PLATFORM.claudeCode, root), { name: 'claude-plugin', version: '0.3.0' })
		assert.deepEqual(readInstalledPlugin(PLATFORM.codex, root), { name: 'codex-plugin', version: '0.4.0' })
	})
})

test('a client that is not listed reads the default manifest', () => {
	const expected = { name: PLUGIN_NAME, version: '0.3.0' }
	withPluginFolder({ '.claude-plugin': expected }, (root) => {
		for (const platform of [undefined, 'toString', 'other-client']) {
			assert.deepEqual(readInstalledPlugin(platform, root), expected, String(platform))
		}
	})
})

test('a missing manifest is an error, so the failure is reported', () => {
	withPluginFolder({ '.claude-plugin': { name: PLUGIN_NAME, version: '0.3.0' } }, (root) => {
		assert.throws(() => readInstalledPlugin(PLATFORM.codex, root), /plugin\.json/)
	})
})

test('a manifest without a supported version is an error', () => {
	for (const version of [undefined, '0.4.0-beta.1', '', 4]) {
		withPluginFolder({ '.codex-plugin': { name: PLUGIN_NAME, version } }, (root) => {
			assert.throws(() => readInstalledPlugin(PLATFORM.codex, root), /version/, String(version))
		})
	}
})

test('a manifest without a usable plugin name is an error', () => {
	const withControl = CONTROL_CHARACTERS.map((character) => `a${character}b`)
	const unusable = [undefined, '', 5, 'n'.repeat(NAME_LIMIT + 1), ...withControl]
	for (const name of unusable) {
		withPluginFolder({ '.codex-plugin': { name, version: '0.4.0' } }, (root) => {
			assert.throws(() => readInstalledPlugin(PLATFORM.codex, root), /installed name/, String(name))
		})
	}
})

test('a plugin name at the limit is accepted', () => {
	withPluginFolder({ '.codex-plugin': { name: 'n'.repeat(NAME_LIMIT), version: '0.4.0' } }, (root) => {
		assert.equal(readInstalledPlugin(PLATFORM.codex, root).name.length, NAME_LIMIT)
	})
})

test('every client the plugin knows has its own manifest entry, so none is read from the fallback', () => {
	for (const platform of Object.values(PLATFORM)) {
		assert.ok(Object.hasOwn(MANIFEST_FILE, platform), platform)
	}
})

test('the manifests of all the clients carry the same name and the same, supported version', () => {
	const [first, ...others] = Object.values(PLATFORM).map((platform) => readInstalledPlugin(platform))
	assert.ok(parseVersion(first.version))
	for (const other of others) assert.deepEqual(other, first)
})

// ---- asking the backend ----

// A key no other text contains, so a test can prove it never leaks.
const SECRET_CONNECTION = { baseUrl: 'http://release.test', apiKey: 'secret-key-xyz789' }
const askWith = (reply) => withFakeFetch(reply, () => fetchLatestRelease(SECRET_CONNECTION))

test('the release is asked for at the release address and its JSON is given back', async () => {
	const { result, sent } = await askWith(textReply(200, JSON.stringify(RELEASE_BODY)))
	assert.deepEqual(result, RELEASE_BODY)
	assert.equal(sent.length, 1)
	assert.equal(sent[0].url, 'http://release.test/api/client/hooks/latest')
	assert.equal(sent[0].options.method, 'GET')
})

test('a failed release request is reported with the release operation and address', async () => {
	const { error } = await askWith(textReply(500, '{"error":"boom"}'))
	assert.ok(error instanceof AiCenterError)
	assert.equal(error.operation, 'release_latest')
	assert.equal(error.endpoint, '/api/client/hooks/latest')
	assert.equal(error.statusCode, 500)
})

test('the check gives up after two seconds and says it timed out', async () => {
	const started = Date.now()
	const { error } = await askWith((options) => new Promise((_, reject) => {
		// A real request keeps the process alive while it waits. The fake needs a timer to do the same.
		const keepAlive = setTimeout(() => {}, 10_000)
		options.signal.addEventListener('abort', () => {
			clearTimeout(keepAlive)
			reject(options.signal.reason)
		})
	}))
	const waited = Date.now() - started
	assert.match(error.message, /timeout after 2s/)
	assert.ok(waited >= 1900 && waited < 4000, `waited ${waited} ms`)
})

// ---- the whole check ----

// Runs the check for a plugin folder whose manifests say `installed`, against a backend that answers `reply`.
async function checkWith({ installed, reply, ...options }) {
	// A test may pass `platform: undefined` on purpose, which is how an unrecognized client looks.
	const platform = 'platform' in options ? options.platform : PLATFORM.claudeCode
	const manifest = { name: PLUGIN_NAME, version: installed }
	const root = makePluginFolder({ '.claude-plugin': manifest, '.codex-plugin': manifest })
	try {
		return await withFakeFetch(reply, () => checkForUpdate({ connection: SECRET_CONNECTION, platform, root }))
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
}
// The backend's answer: the test release with `change` applied.
const releaseReply = (change) => textReply(200, JSON.stringify(withChange(change)))

test('installed 0.1.0 and latest 0.2.0 give the one-line notice, in Claude Code and in Codex', async () => {
	const claude = await checkWith({ installed: '0.1.0', reply: releaseReply({}) })
	assert.equal(claude.result, formatExpectedNotice())
	const codex = await checkWith({ installed: '0.1.0', platform: PLATFORM.codex, reply: releaseReply({}) })
	assert.equal(codex.result, formatExpectedNotice())
})

test('the same version and a newer installed version give no notice', async () => {
	for (const installed of ['0.2.0', '0.2.1', '1.0.0']) {
		const { result, error, sent } = await checkWith({ installed, reply: releaseReply({}) })
		assert.equal(error, undefined, installed)
		assert.equal(result, undefined, installed)
		assert.equal(sent.length, 1, installed)
	}
})

test('versions are compared as numbers: 0.9.0 installed and 0.10.0 latest give the notice', async () => {
	const { result } = await checkWith({ installed: '0.9.0', reply: releaseReply({ latest: '0.10.0' }) })
	assert.match(result, /installed 0\.9\.0, latest 0\.10\.0\./)
})

test('after the plugin is updated the notice stops', async () => {
	assert.ok((await checkWith({ installed: '0.1.0', reply: releaseReply({}) })).result)
	assert.equal((await checkWith({ installed: '0.2.0', reply: releaseReply({}) })).result, undefined)
})

test('a latest version the rules do not support gives no notice, and the reason is reported', async () => {
	for (const latest of ['0.3.0-beta.1', 'latest', '1.2']) {
		const { result, error } = await checkWith({ installed: '0.1.0', reply: releaseReply({ latest }) })
		assert.equal(result, undefined, latest)
		assert.match(error.message, /release answer refused: latest/, latest)
	}
})

test('an installed version the rules do not support gives no notice, and the backend is not asked', async () => {
	const { result, error, sent } = await checkWith({ installed: '0.2.0-beta.1', reply: releaseReply({}) })
	assert.equal(result, undefined)
	assert.match(error.message, /installed version is not supported/)
	assert.equal(sent.length, 0)
})

test('a client that is not listed still gets the notice', async () => {
	const { result, error, sent } = await checkWith({ installed: '0.1.0', platform: undefined, reply: releaseReply({}) })
	assert.equal(error, undefined)
	assert.equal(result, formatExpectedNotice())
	assert.equal(sent.length, 1)
})

test('a backend that is down or answers with an error gives no notice and a reported error', async () => {
	const offline = () => {
		throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })
	}
	for (const reply of [textReply(500, '{"error":"boom"}'), textReply(404, ''), textReply(200, 'not json'), offline]) {
		const { result, error } = await checkWith({ installed: '0.1.0', reply })
		assert.equal(result, undefined)
		assert.ok(error instanceof AiCenterError)
		assert.ok(!`${error.message} ${JSON.stringify(error)}`.includes(SECRET_CONNECTION.apiKey))
	}
})

test('an answer that is not complete gives no notice and a reported reason', async () => {
	for (const body of ['{}', '[]', 'null', '{"notes":"only notes"}']) {
		const { result, error } = await checkWith({ installed: '0.1.0', reply: textReply(200, body) })
		assert.equal(result, undefined, body)
		assert.match(error.message, /release answer refused/, body)
	}
})

test('unexpected fields in the answer change nothing in the notice', async () => {
	const reply = releaseReply({
		command: 'touch /tmp/x',
		run: ['x'],
		notes: 'NOTES-TEXT',
		instructions: { other: 'INSTRUCTION-TEXT' },
	})
	const { result } = await checkWith({ installed: '0.1.0', reply })
	assert.equal(result, formatExpectedNotice())
})

test('the key is in no notice', async () => {
	const { result } = await checkWith({ installed: '0.1.0', reply: releaseReply({}) })
	assert.ok(!result.includes(SECRET_CONNECTION.apiKey))
})
