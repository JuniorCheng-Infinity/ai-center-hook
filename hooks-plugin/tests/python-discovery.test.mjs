import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	ATTEMPT_TIMEOUT_MS,
	SEARCH_TIMEOUT_MS,
	createTomlParser,
} from '../scripts/lib/connection/client-connections.mjs'
import { NO_PYTHON_REASON, REAL_PYTHON } from './real-python.mjs'

// Part 1 uses a stand-in for spawnSync and a chosen platform name, so it runs anywhere
// and proves nothing about a real Windows, Linux or macOS machine.
// Part 2 starts real processes, on Linux and macOS only.

// Text a stand-in Python prints; it must never reach an error message.
const OUTPUT_MARKER = 'MARKER-FROM-PYTHON-OUTPUT'
const TOML_TEXT = 'answer = 42\n'
const WORKING = { version: [3, 12], parsed: { answer: 42 } }

// Answers each launch from the `pythons` table by command, and records every launch.
// Like the real program: exit 0 with the parsed JSON, 3 with its version when tomllib is missing, 4 for invalid TOML.
function buildFakeSpawn(pythons) {
	const calls = []
	const clock = { time: 0 }
	const spawn = (command, args, options) => {
		calls.push({ command, args, options })
		const python = pythons[command]
		if (!python) return { error: { code: 'ENOENT' }, status: null }
		clock.time += python.takes ?? 0
		if (python.launchError) return { error: { code: python.launchError }, status: null }
		if (python.hangs) {
			clock.time += options.timeout
			return { error: { code: 'ETIMEDOUT' }, status: null }
		}
		if (python.exitStatus) return { status: python.exitStatus, stdout: OUTPUT_MARKER, stderr: OUTPUT_MARKER }
		if (python.tomllib === false) {
			const [major, minor] = python.version
			return { status: 3, stdout: `${major} ${minor}\n`, stderr: OUTPUT_MARKER }
		}
		if (python.garbled) return { status: 0, stdout: OUTPUT_MARKER, stderr: '' }
		if (python.invalidToml) return { status: 4, stdout: '', stderr: OUTPUT_MARKER }
		return { status: 0, stdout: JSON.stringify(python.parsed), stderr: '' }
	}
	return { spawn, calls, clock }
}

function buildParser(pythons, { platform = 'linux', env = {} } = {}) {
	const { spawn, calls, clock } = buildFakeSpawn(pythons)
	const parseToml = createTomlParser({ platform, env, spawn, now: () => clock.time })
	return { parseToml, calls }
}

const commandsOf = (calls) => calls.map((call) => call.command)

function buildTempRoot(t) {
	const root = mkdtempSync(join(tmpdir(), 'ai-center-python-test-'))
	t.after(() => rmSync(root, { recursive: true, force: true }))
	return root
}

// A folder holding empty files with the given names, so a PATH scan sees those Python names.
function buildBinWithNames(root, names) {
	const bin = join(root, 'bin')
	mkdirSync(bin)
	for (const name of names) writeFileSync(join(bin, name), '')
	return bin
}

test('simulated: a first Python that is too old is skipped and the next one is used', () => {
	const { parseToml, calls } = buildParser({ python3: { version: [3, 9], tomllib: false }, python: WORKING })

	assert.deepEqual(parseToml(TOML_TEXT), { answer: 42 })
	assert.deepEqual(commandsOf(calls), ['python3', 'python'])
})

test('simulated: a first Python that is missing is skipped and the next one is used', () => {
	const { parseToml, calls } = buildParser({ python: WORKING })

	assert.deepEqual(parseToml(TOML_TEXT), { answer: 42 })
	assert.deepEqual(commandsOf(calls), ['python3', 'python'])
})

test('simulated: a Python with only a newer minor version is found without naming any minor', (t) => {
	const bin = buildBinWithNames(buildTempRoot(t), ['python3.14', 'python3.12-config', 'python3.x'])
	const { parseToml, calls } = buildParser({ 'python3.14': WORKING }, { env: { PATH: bin } })

	assert.deepEqual(parseToml(TOML_TEXT), { answer: 42 })
	assert.deepEqual(commandsOf(calls), ['python3', 'python3.14'])
})

test('simulated: installed minors are tried newest first by number, until one works', (t) => {
	const bin = buildBinWithNames(buildTempRoot(t), ['python3.9', 'python3.10', 'python3.13'])
	const pythons = { 'python3.13': { launchError: 'EACCES' }, 'python3.10': WORKING, 'python3.9': WORKING }
	const { parseToml, calls } = buildParser(pythons, { env: { PATH: bin } })

	assert.deepEqual(parseToml(TOML_TEXT), { answer: 42 })
	assert.deepEqual(commandsOf(calls), ['python3', 'python3.13', 'python3.10'])
})

test('simulated: a PATH entry that is not a folder is logged, a missing one is silent, and the search goes on', (t) => {
	const root = buildTempRoot(t)
	const notAFolder = join(root, 'not-a-folder')
	writeFileSync(notAFolder, '')
	const bin = buildBinWithNames(root, ['python3.14'])
	const missing = join(root, 'missing')
	const written = []
	t.mock.method(process.stderr, 'write', (text) => { written.push(String(text)); return true })
	const { parseToml } = buildParser({ 'python3.14': WORKING }, { env: { PATH: [notAFolder, missing, bin].join(delimiter) } })

	assert.deepEqual(parseToml(TOML_TEXT), { answer: 42 })
	assert.equal(written.length, 1)
	assert.match(written[0], /not-a-folder could not be listed \(ENOTDIR/)
})

test('simulated: PATH is not scanned for python3.N names while python3 works', (t) => {
	const root = buildTempRoot(t)
	const notAFolder = join(root, 'not-a-folder')
	writeFileSync(notAFolder, '')
	const written = []
	t.mock.method(process.stderr, 'write', (text) => { written.push(String(text)); return true })
	const { parseToml, calls } = buildParser({ python3: WORKING }, { env: { PATH: notAFolder } })

	assert.deepEqual(parseToml(TOML_TEXT), { answer: 42 })
	assert.deepEqual(commandsOf(calls), ['python3'])
	assert.equal(written.length, 0)
})

test('simulated Windows: the py launcher is tried first and asked for Python 3', () => {
	const { parseToml, calls } = buildParser({ py: WORKING }, { platform: 'win32' })

	assert.deepEqual(parseToml(TOML_TEXT), { answer: 42 })
	assert.deepEqual(calls.map((call) => [call.command, call.args[0]]), [['py', '-3']])
})

test('simulated Windows: with no launcher, an ordinary python executable is used', () => {
	const { parseToml, calls } = buildParser({ python: WORKING }, { platform: 'win32' })

	assert.deepEqual(parseToml(TOML_TEXT), { answer: 42 })
	assert.deepEqual(commandsOf(calls), ['py', 'python'])
})

test('simulated: launches pass separate arguments, no shell, a time limit, and the text only by stdin', () => {
	const { parseToml, calls } = buildParser({ python3: WORKING })

	parseToml(TOML_TEXT)

	for (const call of calls) {
		assert.ok(Array.isArray(call.args))
		assert.notEqual(call.options.shell, true)
		assert.ok(call.options.timeout > 0)
		assert.ok(!call.args.some((argument) => argument.includes(TOML_TEXT)))
	}
	assert.equal(calls.at(-1).options.input, TOML_TEXT)
})

test('simulated: every launch starts Python isolated with -I, right before -c', () => {
	const { parseToml, calls } = buildParser({ python3: WORKING })

	parseToml(TOML_TEXT)

	for (const call of calls) {
		const flag = call.args.indexOf('-I')
		assert.ok(flag >= 0)
		assert.equal(call.args[flag + 1], '-c')
	}
})

test('simulated: every launch turns off automatic install and leaves the caller env alone', () => {
	const env = { PATH: '/some/bin' }
	const { parseToml, calls } = buildParser({ python3: WORKING }, { env })

	parseToml(TOML_TEXT)

	for (const call of calls) {
		assert.equal(call.options.env.PYTHON_MANAGER_AUTOMATIC_INSTALL, '0')
		assert.equal(call.options.env.PATH, '/some/bin')
	}
	assert.deepEqual(env, { PATH: '/some/bin' })
})

test('simulated: the selected Python is reused, so a later parse launches only that one', () => {
	const { parseToml, calls } = buildParser({ python: WORKING })

	parseToml(TOML_TEXT)
	parseToml(TOML_TEXT)

	assert.deepEqual(commandsOf(calls), ['python3', 'python', 'python'])
})

test('simulated: the whole search stops at its time limit and every launch is capped', (t) => {
	const bin = buildBinWithNames(buildTempRoot(t), ['python3.14', 'python3.13', 'python3.12'])
	const hang = { hangs: true }
	const pythons = { python3: hang, 'python3.14': hang, 'python3.13': hang, 'python3.12': hang, python: hang }
	const { parseToml, calls } = buildParser(pythons, { env: { PATH: bin } })

	assert.throws(() => parseToml(TOML_TEXT), /timed out/)
	assert.deepEqual(
		calls.map((call) => call.options.timeout),
		[ATTEMPT_TIMEOUT_MS, ATTEMPT_TIMEOUT_MS, SEARCH_TIMEOUT_MS - 2 * ATTEMPT_TIMEOUT_MS],
	)
})

test('simulated: a shorter search budget stops the search sooner', () => {
	const { spawn, calls, clock } = buildFakeSpawn({ python3: { hangs: true }, python: WORKING })
	const parseToml = createTomlParser({ platform: 'linux', env: {}, spawn, now: () => clock.time, searchTimeoutMs: 1_000 })

	assert.throws(() => parseToml(TOML_TEXT), /timed out.*the search stopped after 1 s/)
	assert.deepEqual(calls.map((call) => call.options.timeout), [1_000])
})

const FAILURES = [
	['no Python is installed', {}, /Python was not found/],
	[
		'only too-old Pythons are installed',
		{ python3: { version: [3, 9], tomllib: false }, python: { version: [3, 8], tomllib: false } },
		/tried 3\.9, 3\.8.*3\.11 or newer/,
	],
	['a Python cannot be started', { python3: { launchError: 'EACCES' } }, /python3: EACCES/],
	[
		'a Python exits with an unexpected status',
		{ python3: { exitStatus: 9009 } },
		/python3: exited with status 9009/,
	],
	['a Python times out', { python3: { hangs: true } }, /python3: timed out/],
	['a Python returns unreadable output', { python3: { ...WORKING, garbled: true } }, /python3: returned output/],
	[
		'one Python is too old and another cannot be run',
		{ python3: { version: [3, 9], tomllib: false }, python: { exitStatus: 9009 } },
		/tried 3\.9.*python: exited with status 9009/,
	],
	[
		'the search runs out of time',
		{ python3: { takes: SEARCH_TIMEOUT_MS, version: [3, 9], tomllib: false }, python: WORKING },
		/tried 3\.9.*the search stopped after 5 s/,
	],
]

for (const [name, pythons, expected] of FAILURES) {
	test(`simulated: when ${name}, the message says so, asks for Python 3.11 or newer, and never repeats the process output`, () => {
		const { parseToml } = buildParser(pythons)

		assert.throws(() => parseToml(TOML_TEXT), (error) => {
			assert.match(error.message, expected)
			assert.match(error.message, /3\.11 or newer/)
			assert.doesNotMatch(error.message, new RegExp(OUTPUT_MARKER))
			return true
		})
	})
}

test('simulated: invalid TOML is reported as invalid TOML and is not retried with another Python', () => {
	const { parseToml, calls } = buildParser({ python3: { ...WORKING, invalidToml: true }, python: WORKING })

	assert.throws(() => parseToml(TOML_TEXT), (error) => {
		assert.match(error.message, /not valid TOML/)
		assert.doesNotMatch(error.message, new RegExp(OUTPUT_MARKER))
		return true
	})
	assert.deepEqual(commandsOf(calls), ['python3'])
})

// A real fake Python is a shell script, so part 2 cannot run on Windows.
const SKIP_ON_WINDOWS = process.platform === 'win32' && 'needs shell scripts and a PATH search'
const SKIP_WITHOUT_PYTHON = SKIP_ON_WINDOWS || NO_PYTHON_REASON

function writeScript(dir, name, body) {
	const file = join(dir, name)
	writeFileSync(file, `#!/bin/sh\n${body}\n`)
	chmodSync(file, 0o755)
	return file
}

test('real processes: an old python3 is skipped for a working Python in a folder with spaces', {
	skip: SKIP_WITHOUT_PYTHON,
}, (t) => {
	const root = buildTempRoot(t)
	const oldBin = join(root, 'old bin')
	const goodBin = join(root, 'good bin')
	mkdirSync(oldBin)
	mkdirSync(goodBin)
	writeScript(oldBin, 'python3', 'echo "3 9"; exit 3')
	writeScript(goodBin, 'python3.13', `exec "${REAL_PYTHON}" "$@"`)
	const parseToml = createTomlParser({ env: { PATH: [oldBin, goodBin].join(delimiter) } })

	assert.deepEqual(parseToml('answer = 42\n[table]\nname = "x"\n'), { answer: 42, table: { name: 'x' } })
})

test('real Python: a tomllib.py or json.py in the working folder is not run', {
	skip: SKIP_WITHOUT_PYTHON,
}, (t) => {
	const folder = buildTempRoot(t)
	writeFileSync(join(folder, 'tomllib.py'), 'open("RAN-tomllib", "w").write("x")\n')
	writeFileSync(join(folder, 'json.py'), 'open("RAN-json", "w").write("x")\n')
	const spawnInFolder = (command, args, options) => spawnSync(command, args, { ...options, cwd: folder })
	const parseToml = createTomlParser({ env: process.env, spawn: spawnInFolder })

	assert.deepEqual(parseToml(TOML_TEXT), { answer: 42 })
	assert.deepEqual(readdirSync(folder).sort(), ['json.py', 'tomllib.py'])
})

test('real Python: a TOML date is read, and invalid TOML is reported as invalid TOML', {
	skip: SKIP_WITHOUT_PYTHON,
}, () => {
	const parseToml = createTomlParser({ env: process.env })

	assert.deepEqual(parseToml('when = 2026-11-24\n'), { when: '2026-11-24' })
	assert.throws(() => parseToml('this = = not toml'), /not valid TOML/)
})

test('real Python: TOML inf, nan and float values are read as text and do not break the parse', {
	skip: SKIP_WITHOUT_PYTHON,
}, () => {
	const parseToml = createTomlParser({ env: process.env })

	assert.deepEqual(parseToml('big = inf\nnone = nan\nratio = 1.5\n'), { big: 'inf', none: 'nan', ratio: '1.5' })
})

test('real processes: a Python that crashes with exit status 1 is not reported as invalid TOML', {
	skip: SKIP_ON_WINDOWS,
}, (t) => {
	const bin = join(buildTempRoot(t), 'crash bin')
	mkdirSync(bin)
	writeScript(bin, 'python3', 'IFS= read -r line\nif [ -z "$line" ]; then echo "3 12"; exit 0; fi\nexit 1')
	const parseToml = createTomlParser({ env: { PATH: bin } })

	assert.throws(() => parseToml(TOML_TEXT), (error) => {
		assert.match(error.message, /python3: exited with status 1/)
		assert.doesNotMatch(error.message, /not valid TOML/)
		return true
	})
})

test('real processes: with no Python on PATH the message says Python was not found', {
	skip: SKIP_ON_WINDOWS,
}, (t) => {
	const emptyBin = join(buildTempRoot(t), 'empty bin')
	mkdirSync(emptyBin)
	const parseToml = createTomlParser({ env: { PATH: emptyBin } })

	assert.throws(() => parseToml(TOML_TEXT), /Python was not found/)
})

test('real processes: a Python that hangs is stopped at the time limit', { skip: SKIP_ON_WINDOWS }, (t) => {
	const bin = join(buildTempRoot(t), 'slow bin')
	mkdirSync(bin)
	writeScript(bin, 'python3', 'while :; do :; done')
	const parseToml = createTomlParser({ env: { PATH: bin } })

	assert.throws(() => parseToml(TOML_TEXT), /python3: timed out/)
})

test('real process: SessionEnd finishes inside its hook timeout even when every Python hangs', {
	skip: SKIP_ON_WINDOWS,
}, (t) => {
	const root = buildTempRoot(t)
	const repo = join(root, 'repo')
	const bin = join(root, 'hang bin')
	mkdirSync(join(repo, '.git'), { recursive: true })
	mkdirSync(join(repo, '.codex'))
	mkdirSync(bin)
	writeFileSync(join(repo, '.codex', 'config.toml'), '[mcp_servers.ai-center]\nurl = "http://x.invalid/mcp"\n')
	for (const name of ['python3', 'python3.99', 'python']) writeScript(bin, name, 'while :; do :; done')
	const config = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8'))
	const timeoutMs = config.hooks.SessionEnd[0].hooks[0].timeout * 1000
	const script = fileURLToPath(new URL('../scripts/session-end.mjs', import.meta.url))
	const env = { PATH: bin, HOME: root, PLUGIN_ROOT: '/fake/.codex/plugins/cache/x', PLUGIN_DATA: join(root, 'data') }

	const started = Date.now()
	const result = spawnSync(process.execPath, [script], { input: JSON.stringify({ cwd: repo }), env, encoding: 'utf8' })

	assert.equal(result.status, 0)
	assert.ok(Date.now() - started < timeoutMs, `took ${Date.now() - started} ms, the hook allows ${timeoutMs} ms`)
})
