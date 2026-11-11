import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setupHookRun } from './fake-ai-center.mjs'

const RULES = 'context.mjs rules'
const PROGRESS = 'context.mjs progress'
// A prompt or a closing block above this is not shown, only pointed to.
const LONG_ENTRY = 800
// The page limit comes from the client the hook runs in, so a test that depends on it names the client.
const CLAUDE_CODE = { CLAUDECODE: '1' }
const CODEX = { CLAUDECODE: '', PLUGIN_ROOT: '/home/user/.codex/plugins/ai-assistant-mem' }
const UNKNOWN_CLIENT = { CLAUDECODE: '', PLUGIN_ROOT: '' }
const CLIENTS = [
	['Claude Code', CLAUDE_CODE, 9500],
	['Codex', CODEX, 7000],
	['a client it cannot recognize', UNKNOWN_CLIENT, 7000],
]

function hookTest(name, body) {
	test(name, () => {
		const hook = setupHookRun()
		try {
			body(hook)
		} finally {
			hook.cleanup()
		}
	})
}

const startOf = (dir) => ({ cwd: dir, hook_event_name: 'SessionStart', source: 'startup' })
const contextOf = (result) => JSON.parse(result.stdout).hookSpecificOutput.additionalContext
const item = (id, memory) => ({ id, memory })
const withProfile = ({ rules = [], preferences = [], facts = [] }) =>
	({ FAKE_PROFILE: JSON.stringify({ static: rules, dynamic: facts, buckets: { preferences } }) })
const minute = (m) => `2026-11-04T08:${String(m).padStart(2, '0')}:00.000Z`
const note = (id, title, created, content, updated = created) =>
	({ id, title, type: 'text', system: { createdAt: minute(created), updatedAt: minute(updated) }, content })
const turn = (id, created, prompt, response, updated = created) =>
	note(id, `User prompt: ${prompt}`.slice(0, 50), created, `User prompt: ${prompt}\n\nResponse: ${response}`, updated)
const aiNote = (id, title, created, updated = created) => note(id, title, created, `Text of ${title}`, updated)
const withDocuments = (...documents) => ({ FAKE_DOCUMENTS: JSON.stringify(documents) })
// Words that no other text shares, so that the duplicate guard never meets them by accident.
const unique = (label) => [0, 1, 2, 3].map((k) => `${label}w${k}`).join(' ')
const textOf = (label, length) => {
	let out = ''
	for (let k = 0; out.length < length; k += 1) out += `${label}w${k} `
	return out.slice(0, length).trimEnd()
}
// Exactly this many characters, for the tests that sit on an edge.
const exactText = (label, length) => textOf(label, length).padEnd(length, 'x')
const turnsIn = (context) => [...context.matchAll(/doc=(turn-[\w-]+)/g)].map((match) => match[1])
const callsOf = (toolCalls, name) => toolCalls().filter((call) => call.name === name)

function assertInOrder(context, needles) {
	const positions = needles.map((needle) => context.indexOf(needle))
	needles.forEach((needle, i) => assert.ok(positions[i] >= 0, `missing: ${needle.slice(0, 60)}`))
	assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'wrong order')
}

// ---- settings and arguments ----

test('SessionStart runs the rules hook and the progress hook under one matcher that includes fork', () => {
	const root = resolve('hooks-plugin')
	const config = JSON.parse(readFileSync(join(root, 'hooks/hooks.json'), 'utf8'))
	const [group, ...others] = config.hooks.SessionStart
	assert.equal(others.length, 0)
	assert.equal(group.matcher, 'startup|resume|clear|compact|fork')
	assert.equal(group.hooks.length, 2)
	assert.match(group.hooks[0].command, /\/scripts\/context\.mjs" rules$/)
	assert.match(group.hooks[1].command, /\/scripts\/context\.mjs" progress$/)
	for (const hook of group.hooks) assert.ok(hook.timeout > 0)
	assert.ok(existsSync(join(root, 'scripts/context.mjs')))
})

hookTest('a missing or unknown argument is reported and the session still starts', ({ dir, runScript, failures, sentRequests }) => {
	// toString is a name every object has, so it must be refused like any other unknown argument.
	for (const args of [[], ['bogus'], ['toString']]) assert.equal(runScript('context.mjs', args, startOf(dir)).stdout, '')
	const recorded = failures()
	assert.deepEqual(recorded.map((failure) => failure.hook), ['context', 'context', 'context'])
	for (const failure of recorded) {
		assert.match(failure.info, /rules/)
		assert.match(failure.info, /progress/)
	}
	assert.deepEqual(sentRequests(), [])
})

hookTest('neither hook searches memory by the name of the project any more', ({ dir, run, toolCalls }) => {
	run(RULES, startOf(dir))
	run(PROGRESS, startOf(dir))
	assert.equal(callsOf(toolCalls, 'memory_search').length, 0)
})

// ---- the user: asked on every run, never cached, never guessed ----

hookTest('the rules hook asks who the user is on every run and sends the id with the profile call', ({ dir, run, toolCalls }) => {
	run(RULES, startOf(dir), '', withProfile({ rules: [item('s1', 'Rule one here.')] }))
	assert.equal(callsOf(toolCalls, 'get_me').length, 1)
	assert.equal(callsOf(toolCalls, 'profile_get')[0].arguments.user_id, 11)
	run(RULES, startOf(dir))
	assert.equal(callsOf(toolCalls, 'get_me').length, 2)
})

hookTest('the progress hook asks who the user is on every run, caches nothing about the user, and sends the id', ({ dir, run, toolCalls, projectCache }) => {
	run(PROGRESS, startOf(dir))
	assert.equal(callsOf(toolCalls, 'get_me').length, 1)
	assert.deepEqual(Object.keys(projectCache()).sort(), ['addContentMaxChars', 'projectId'])
	const sentWithUser = [...callsOf(toolCalls, 'profile_get'), ...callsOf(toolCalls, 'document_list')]
	assert.equal(sentWithUser.length, 4)
	for (const call of sentWithUser) assert.equal(call.arguments.user_id, 11)
	run(PROGRESS, startOf(dir))
	assert.equal(callsOf(toolCalls, 'get_me').length, 2)
})

for (const [hook, script] of [['rules', RULES], ['progress', PROGRESS]]) {
	hookTest(`a get_me reply without a user id stops the ${hook} hook loudly, never showing the whole project`, ({ dir, run, toolCalls, failures }) => {
		const result = run(script, startOf(dir), '', { FAKE_ME: JSON.stringify({ user: {} }), ...withProfile({ rules: [item('s1', 'Rule.')] }) })
		assert.equal(result.stdout, '')
		assert.match(failures()[0].info, /no user id/)
		assert.equal(failures()[0].display, 'pending')
		assert.equal(callsOf(toolCalls, 'profile_get').length, 0)
	})
}

// ---- rules hook ----

hookTest('the rules hook asks for the profile of this user and prints static rules before preferences', ({ dir, run, toolCalls }) => {
	const context = contextOf(run(RULES, startOf(dir), '', withProfile({
		rules: [item('s1', 'Static rule alpha.'), item('s2', 'Static rule beta.')],
		preferences: [item('p1', 'Preference gamma.')],
	})))
	const [profile] = callsOf(toolCalls, 'profile_get')
	assert.equal(profile.arguments.project_id, 42)
	assert.equal(profile.arguments.user_id, 11)
	assert.deepEqual(profile.arguments.buckets, ['preferences'])
	assertInOrder(context, ['Static rule alpha.', 'Static rule beta.', 'Preference gamma.'])
})

hookTest('a rule that is in both lists with the same id is printed once', ({ dir, run }) => {
	const context = contextOf(run(RULES, startOf(dir), '', withProfile({
		rules: [item('s1', 'Shared rule text.')],
		preferences: [item('s1', 'Shared rule text.')],
	})))
	assert.equal(context.split('Shared rule text.').length - 1, 1)
})

hookTest('a rule with the same text apart from case, date, punctuation and spacing is dropped', ({ dir, run }) => {
	const context = contextOf(run(RULES, startOf(dir), '', withProfile({
		rules: [item('s1', '[2026-11-04] The user forbids committing unless explicitly asked.')],
		preferences: [item('p1', 'the USER  forbids committing; unless explicitly asked!')],
	})))
	assert.ok(context.includes('The user forbids committing unless explicitly asked.'))
	assert.ok(!context.includes('the USER  forbids committing'))
})

hookTest('a rule sharing 0.6 or more of its words with a kept rule is dropped, and one sharing less is kept', ({ dir, run }) => {
	const context = contextOf(run(RULES, startOf(dir), '', withProfile({
		rules: [
			item('a1', 'alpha beta gamma delta'),
			item('a2', 'alpha beta gamma omega'),
			item('b1', 'sigma kappa lambda'),
			item('b2', 'sigma kappa theta'),
		],
	})))
	assert.ok(context.includes('alpha beta gamma delta'))
	assert.ok(!context.includes('omega'))
	assert.ok(context.includes('sigma kappa lambda'))
	assert.ok(context.includes('sigma kappa theta'))
})

hookTest('words of two letters or fewer do not count towards the overlap', ({ dir, run }) => {
	const context = contextOf(run(RULES, startOf(dir), '', withProfile({
		rules: [item('c1', 'alpha beta gamma'), item('c2', 'alpha beta gamma is to of a')],
	})))
	assert.ok(context.includes('alpha beta gamma'))
	assert.ok(!context.includes('is to of a'))
})

hookTest('two different rules that share only common words are both kept', ({ dir, run }) => {
	const context = contextOf(run(RULES, startOf(dir), '', withProfile({
		rules: [
			item('d1', 'The user requires tests first.'),
			item('d2', 'The user requires lines under 120 characters.'),
		],
	})))
	assert.ok(context.includes('The user requires tests first.'))
	assert.ok(context.includes('The user requires lines under 120 characters.'))
})

hookTest('a rule that is almost entirely inside a longer rule is not shown on its own', ({ dir, run }) => {
	const short = item('s', 'The user forbids editing `admin-ui/components.d.ts`.')
	const long = item('l', 'The user prohibits `git add .` and prohibits editing `admin-ui/components.d.ts`.')
	for (const rules of [[short, long], [long, short]]) {
		const context = contextOf(run(RULES, startOf(dir), '', withProfile({ rules })))
		assert.ok(context.includes(long.memory))
		assert.ok(!context.includes('The user forbids editing'))
	}
})

hookTest('when two entries state the same rule, the stronger wording is the one shown', ({ dir, run }) => {
	const context = contextOf(run(RULES, startOf(dir), '', withProfile({
		rules: [
			item('w1', 'The user prefers work to proceed one step at a time.'),
			item('w2', 'The user requires work to proceed one step at a time.'),
		],
	})))
	assert.ok(context.includes('requires work to proceed one step at a time'))
	assert.ok(!context.includes('prefers work to proceed one step at a time'))
})

hookTest('the rules hook prints nothing when there are no rules', ({ dir, run }) => {
	assert.equal(run(RULES, startOf(dir)).stdout, '')
})

hookTest('a rule longer than the entry limit is never shown cut', ({ dir, run }) => {
	const long = textOf('longrule', LONG_ENTRY + 100)
	const context = contextOf(run(RULES, startOf(dir), '', withProfile({
		rules: [item('s1', 'Short rule before.'), item('s2', long), item('s3', 'Short rule after.')],
	})))
	assert.ok(context.includes('Short rule before.'))
	assert.ok(context.includes('Short rule after.'))
	assert.ok(!context.includes(long.slice(0, 100)))
})

for (const [name, client, limit] of CLIENTS) {
	hookTest(`on ${name} the rules hook keeps adding whole rules up to ${limit} characters, then says how many are left`, ({ dir, run }) => {
		const rules = Array.from({ length: 60 }, (_, i) => item(`r${i}`, textOf(`rule${i}`, 200)))
		const context = contextOf(run(RULES, startOf(dir), '', { ...client, ...withProfile({ rules }) }))
		assert.ok(context.length <= limit, `printed ${context.length} characters`)
		assert.ok(context.length > limit - 400, `printed only ${context.length} characters, the page was not filled`)
		const shown = rules.filter((rule) => context.includes(rule.memory))
		assert.ok(shown.length > 20 && shown.length < rules.length)
		assert.deepEqual(shown, rules.slice(0, shown.length))
		for (const rule of rules.slice(shown.length)) assert.ok(!context.includes(rule.memory.slice(0, 60)), 'a rule was cut')
		assert.match(context, new RegExp(`${rules.length - shown.length} more`))
		assert.match(context, /profile_get/)
	})
}

hookTest('Claude Code has room for more rules than Codex', ({ dir, run }) => {
	const rules = Array.from({ length: 60 }, (_, i) => item(`r${i}`, textOf(`rule${i}`, 200)))
	const onClaude = contextOf(run(RULES, startOf(dir), '', { ...CLAUDE_CODE, ...withProfile({ rules }) }))
	const onCodex = contextOf(run(RULES, startOf(dir), '', { ...CODEX, ...withProfile({ rules }) }))
	const shownOn = (context) => rules.filter((rule) => context.includes(rule.memory)).length
	assert.ok(shownOn(onClaude) > shownOn(onCodex))
})

hookTest('the rules hook reads the cached project, asks who the user is, and does not refresh the cache', ({ dir, run, sentRequests, projectCache }) => {
	run(PROGRESS, startOf(dir), '', { FAKE_ADD_LIMIT: '5000' })
	const before = sentRequests().length
	run(RULES, startOf(dir), '', { FAKE_ADD_LIMIT: '7777', ...withProfile({ rules: [item('s1', 'Rule one here.')] }) })
	const sent = sentRequests().slice(before)
	assert.ok(sent.some((request) => request.params?.name === 'profile_get'))
	assert.equal(sent.filter((request) => request.params?.name === 'get_me').length, 1)
	assert.ok(!sent.some((request) => request.method === 'initialize' || request.method === 'tools/list'))
	assert.equal(projectCache().addContentMaxChars, 5000)
})

hookTest('a failing server stops the rules hook quietly and the failure is recorded', ({ dir, run, message, failures }) => {
	const result = run(RULES, startOf(dir), 'server-error')
	assert.equal(result.stdout, '')
	assert.equal(message(result), undefined)
	assert.deepEqual(failures().map((failure) => [failure.hook, failure.display]), [['context', 'pending']])
})

hookTest('profile entries without text are skipped, and the skip is reported once with its count', ({ dir, run, failures }) => {
	const context = contextOf(run(RULES, startOf(dir), '', withProfile({
		rules: [item('a', null), { id: 'b' }, item('c', '   ')],
		preferences: [item('d', 'A valid rule here.')],
	})))
	assert.ok(context.includes('A valid rule here.'))
	const recorded = failures()
	assert.equal(recorded.length, 1)
	assert.match(recorded[0].info, /without text skipped: 3/)
	assert.equal(recorded[0].display, 'pending')
})

// ---- progress hook: calls ----

hookTest('the progress hook lists the 5 newest by update and by creation, and the 100 newest to find AI notes', ({ dir, run, toolCalls }) => {
	run(PROGRESS, startOf(dir))
	const pick = ({ project_id, user_id, sort, order, limit }) => ({ project_id, user_id, sort, order, limit })
	const lists = callsOf(toolCalls, 'document_list').map((call) => pick(call.arguments))
	assert.deepEqual(lists, [
		{ project_id: 42, user_id: 11, sort: 'updatedAt', order: 'desc', limit: 5 },
		{ project_id: 42, user_id: 11, sort: 'createdAt', order: 'desc', limit: 5 },
		{ project_id: 42, user_id: 11, sort: 'updatedAt', order: 'desc', limit: 100 },
	])
})

hookTest('the progress hook prints the first 10 distinct recent facts from the profile, in order', ({ dir, run }) => {
	const facts = [
		item('f1', unique('f1')),
		item('f2', unique('f2')),
		item('f2', unique('f2again')),
		item('f4', 'alpha beta gamma delta epsilon zeta'),
		item('f5', 'alpha beta gamma delta epsilon theta'),
		...[6, 7, 8, 9, 10, 11, 12, 13].map((n) => item(`f${n}`, unique(`f${n}`))),
	]
	const context = contextOf(run(PROGRESS, startOf(dir), '', withProfile({ facts })))
	assertInOrder(context, [
		unique('f1'), unique('f2'), 'alpha beta gamma delta epsilon zeta',
		...[6, 7, 8, 9, 10, 11, 12].map((n) => unique(`f${n}`)),
	])
	assert.ok(!context.includes(unique('f2again')))
	assert.ok(!context.includes('epsilon theta'))
	assert.ok(!context.includes(unique('f13')))
})

hookTest('a recent fact longer than the entry limit is left out, never cut', ({ dir, run }) => {
	const long = textOf('longfact', LONG_ENTRY + 100)
	const context = contextOf(run(PROGRESS, startOf(dir), '', withProfile({
		facts: [item('f1', 'Short fact one.'), item('f2', long), item('f3', 'Short fact three.')],
	})))
	assert.ok(context.includes('Short fact one.'))
	assert.ok(context.includes('Short fact three.'))
	assert.ok(!context.includes(long.slice(0, 100)))
})

hookTest('recent facts without text are skipped, and the skip is reported once with its count', ({ dir, run, failures }) => {
	const context = contextOf(run(PROGRESS, startOf(dir), '', withProfile({ facts: [item('f1', null), item('f2', 'A valid fact.')] })))
	assert.ok(context.includes('A valid fact.'))
	const recorded = failures()
	assert.equal(recorded.length, 1)
	assert.match(recorded[0].info, /without text skipped: 1/)
})

hookTest('the progress hook prints nothing when there is nothing to show', ({ dir, run }) => {
	assert.equal(run(PROGRESS, startOf(dir)).stdout, '')
})

// ---- progress hook: which notes ----

hookTest('the recent documents are the union of the newest 5 by update and the newest 5 by creation', ({ dir, run, toolCalls }) => {
	const documents = [
		turn('turn-1', 50, 'prompt one', 'closing one?'),
		turn('turn-2', 10, 'prompt two', 'closing two?', 55),
		turn('turn-3', 45, 'prompt three', 'closing three?'),
		turn('turn-4', 40, 'prompt four', 'closing four?'),
		turn('turn-5', 35, 'prompt five', 'closing five?'),
		turn('turn-6', 30, 'prompt six', 'closing six?'),
		aiNote('note-1', 'HANDOFF alpha', 20, 54),
		aiNote('note-2', 'HANDOFF beta', 20, 53),
		aiNote('note-3', 'HANDOFF gamma', 20, 52),
		aiNote('note-4', 'HANDOFF delta', 20, 51),
	]
	const context = contextOf(run(PROGRESS, startOf(dir), '', withDocuments(...documents)))
	// turn-2 comes from the update list only; turn-1 and turn-3 to turn-6 come from the creation list only.
	assert.deepEqual(turnsIn(context), ['turn-2', 'turn-1', 'turn-3', 'turn-4', 'turn-5', 'turn-6'])
	assert.equal(callsOf(toolCalls, 'document_list').length, 3)
})

hookTest('every turn found in the two lists is printed, up to 10, newest first', ({ dir, run }) => {
	const fromUpdateList = [1, 2, 3, 4, 5].map((n) => turn(`turn-a${n}`, 10, `prompt a${n}`, `closing a${n}?`, 56 - n))
	const fromCreationList = [1, 2, 3, 4, 5].map((n) => turn(`turn-b${n}`, 51 - n, `prompt b${n}`, `closing b${n}?`, 21 - n))
	const inNeitherList = [1, 2, 3].map((n) => turn(`turn-c${n}`, 30, `prompt c${n}`, `closing c${n}?`))
	const context = contextOf(run(PROGRESS, startOf(dir), '', withDocuments(...fromUpdateList, ...fromCreationList, ...inNeitherList)))
	assert.deepEqual(turnsIn(context), [
		'turn-a1', 'turn-a2', 'turn-a3', 'turn-a4', 'turn-a5', 'turn-b1', 'turn-b2', 'turn-b3', 'turn-b4', 'turn-b5',
	])
})

hookTest('a document found by both lists is printed once', ({ dir, run }) => {
	const context = contextOf(run(PROGRESS, startOf(dir), '', withDocuments(
		turn('turn-1', 30, 'prompt one', 'closing one?'),
		turn('turn-2', 20, 'prompt two', 'closing two?'),
		turn('turn-3', 10, 'prompt three', 'closing three?'),
	)))
	assert.deepEqual(turnsIn(context), ['turn-1', 'turn-2', 'turn-3'])
})

hookTest('documents updated at the same moment are ordered by creation time, newest first', ({ dir, run }) => {
	const context = contextOf(run(PROGRESS, startOf(dir), '', withDocuments(
		turn('turn-a', 20, 'prompt a', 'closing a?', 60),
		turn('turn-b', 30, 'prompt b', 'closing b?', 60),
	)))
	assert.deepEqual(turnsIn(context), ['turn-b', 'turn-a'])
})

hookTest('a compaction summary stored as a prompt is skipped and the next turn takes its place', ({ dir, run }) => {
	const documents = [
		turn('turn-1', 15, 'Continued from a session that ran out of context. Earlier work: a long summary', 'Ready?'),
		turn('turn-2', 14, 'prompt two', 'closing two?'),
		turn('turn-3', 13, 'prompt three', 'closing three?'),
		turn('turn-4', 12, 'prompt four', 'closing four?'),
		turn('turn-5', 11, 'prompt five', 'closing five?'),
	]
	const context = contextOf(run(PROGRESS, startOf(dir), '', withDocuments(...documents)))
	assert.deepEqual(turnsIn(context), ['turn-2', 'turn-3', 'turn-4', 'turn-5'])
	assert.ok(!context.includes('Continued from a session'))
})

hookTest('a compaction summary saved word for word is skipped too, and not reported as an error', ({ dir, run, failures }) => {
	const summary = 'This session is being continued from a previous conversation that ran out of context.'
	const context = contextOf(run(PROGRESS, startOf(dir), '', withDocuments(
		turn('turn-1', 15, summary, 'Ready?'),
		turn('turn-2', 14, 'prompt two', 'closing two?'),
	)))
	assert.deepEqual(turnsIn(context), ['turn-2'])
	assert.deepEqual(failures(), [])
})

hookTest('the notes written by the AI are listed by id and title, newest first, and never read', ({ dir, run, toolCalls }) => {
	const documents = [
		turn('turn-1', 40, 'prompt one', 'closing one?'),
		...['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'].map((name, i) =>
			aiNote(`note-${name}`, `HANDOFF ${name}`, 10, 30 - i)),
	]
	const context = contextOf(run(PROGRESS, startOf(dir), '', withDocuments(...documents)))
	assertInOrder(context, [
		'doc=note-alpha', 'HANDOFF alpha', 'doc=note-beta', 'HANDOFF beta', 'doc=note-gamma', 'HANDOFF gamma',
		'doc=note-delta', 'HANDOFF delta', 'doc=note-epsilon', 'HANDOFF epsilon', 'doc=note-zeta', 'HANDOFF zeta',
	])
	const read = callsOf(toolCalls, 'document_get').map((call) => call.arguments.document_id)
	assert.deepEqual(read, ['turn-1'])
})

hookTest('a note written by the AI that the newest turns have pushed out of the short lists is still listed', ({ dir, run }) => {
	const turns = Array.from({ length: 12 }, (_, i) => turn(`turn-${i + 1}`, 60 - i, `prompt ${i + 1}`, `closing ${i + 1}?`))
	const context = contextOf(run(PROGRESS, startOf(dir), '', withDocuments(...turns, aiNote('note-old', 'HANDOFF old', 10, 10))))
	assert.deepEqual(turnsIn(context), ['turn-1', 'turn-2', 'turn-3', 'turn-4', 'turn-5'])
	assert.ok(context.includes('[6] doc=note-old  HANDOFF old'))
})

hookTest('the notes written by the AI are listed with the latest update first, whichever list found them', ({ dir, run }) => {
	const turns = [1, 2, 3, 4, 5].map((n) => turn(`turn-${n}`, 41 - n, `prompt ${n}`, `closing ${n}?`, 51 - n))
	const context = contextOf(run(PROGRESS, startOf(dir), '', withDocuments(
		...turns,
		// Found by the creation list: made last, but quiet since.
		aiNote('note-new-and-quiet', 'HANDOFF created last', 59, 20),
		// Found only by the long list: made first, but updated more recently.
		aiNote('note-old-and-busy', 'HANDOFF updated last', 1, 30),
	)))
	assertInOrder(context, ['doc=note-old-and-busy', 'doc=note-new-and-quiet'])
})

hookTest('a note written by the AI that is in the short lists and the long one is listed once', ({ dir, run }) => {
	const context = contextOf(run(PROGRESS, startOf(dir), '', withDocuments(
		turn('turn-1', 40, 'prompt one', 'closing one?'),
		aiNote('note-a', 'HANDOFF alpha', 10, 50),
	)))
	assert.equal(context.split('doc=note-a').length - 1, 1)
})

// ---- progress hook: reading a turn note ----

hookTest('a turn is printed with its id, the prompt and the closing block of the reply', ({ dir, run }) => {
	const context = contextOf(run(PROGRESS, startOf(dir), '', withDocuments(
		turn('turn-1', 10, 'Where is the config file stored?', 'It is in the home folder.\n\nShall I open it?'),
	)))
	assertInOrder(context, ['doc=turn-1', 'Where is the config file stored?', 'Shall I open it?'])
	assert.ok(!context.includes('It is in the home folder.'))
})

hookTest('summary labels are read like plain ones', ({ dir, run }) => {
	const content = 'User prompt (summary): Long ask about caps.\n\nResponse (summary): Settled. Anything else?'
	const context = contextOf(run(PROGRESS, startOf(dir), '', withDocuments(
		note('turn-1', 'User prompt (summary): Long ask', 10, content),
	)))
	assertInOrder(context, ['doc=turn-1', 'Long ask about caps.', 'Anything else?'])
})

hookTest('several prompts stored as a numbered list are all printed, in order', ({ dir, run }) => {
	const content = 'User prompt:\n1. ok go ahead with the test list\n2. but check the caps first\n\nResponse: Fine, caps first.'
	const context = contextOf(run(PROGRESS, startOf(dir), '', withDocuments(
		note('turn-1', 'User prompt:\n1. ok go ahead with the test list\n2....', 10, content),
	)))
	assertInOrder(context, ['doc=turn-1', 'ok go ahead with the test list', 'but check the caps first', 'Fine, caps first.'])
})

hookTest('the thinking of a turn is not printed', ({ dir, run }) => {
	const content = 'User prompt: a question here\n\nThinking:\nsecret reasoning one\n\nsecret reasoning two\n\nResponse: The answer is yes?'
	const context = contextOf(run(PROGRESS, startOf(dir), '', withDocuments(note('turn-1', 'User prompt: a question here', 10, content))))
	assert.ok(context.includes('a question here'))
	assert.ok(context.includes('The answer is yes?'))
	assert.ok(!context.includes('secret reasoning'))
})

hookTest('a note without a response still prints its prompt', ({ dir, run }) => {
	const context = contextOf(run(PROGRESS, startOf(dir), '', withDocuments(
		note('turn-1', 'User prompt: only a prompt here', 10, 'User prompt: only a prompt here'),
	)))
	assertInOrder(context, ['doc=turn-1', 'only a prompt here'])
})

hookTest('a short prompt such as ok is printed with the closing block it answers', ({ dir, run }) => {
	const context = contextOf(run(PROGRESS, startOf(dir), '', withDocuments(
		turn('turn-1', 10, 'ok', 'The plan is ready.\n\nShall I start the build?'),
	)))
	assert.match(context, /\bok\b/)
	assert.ok(context.includes('Shall I start the build?'))
})

hookTest('the closing block starts at the paragraph holding the last question and runs to the end', ({ dir, run }) => {
	const response = 'Intro paragraph one.\n\nDecision needed: keep this?\n\nOnce you answer I will start.'
	const context = contextOf(run(PROGRESS, startOf(dir), '', withDocuments(turn('turn-1', 10, 'prompt', response))))
	assert.ok(context.includes('Decision needed: keep this?'))
	assert.ok(context.includes('Once you answer I will start.'))
	assert.ok(!context.includes('Intro paragraph one.'))
})

hookTest('with several questions the closing block starts at the paragraph of the last one', ({ dir, run }) => {
	const response = 'Early question?\n\nMiddle statement here.\n\nFinal question?'
	const context = contextOf(run(PROGRESS, startOf(dir), '', withDocuments(turn('turn-1', 10, 'prompt', response))))
	assert.ok(context.includes('Final question?'))
	assert.ok(!context.includes('Middle statement here.'))
	assert.ok(!context.includes('Early question?'))
})

hookTest('with no question the closing block is the last paragraph', ({ dir, run }) => {
	const response = 'Intro paragraph one.\n\nMiddle paragraph two.\n\nFinal line here.'
	const context = contextOf(run(PROGRESS, startOf(dir), '', withDocuments(turn('turn-1', 10, 'prompt', response))))
	assert.ok(context.includes('Final line here.'))
	assert.ok(!context.includes('Middle paragraph two.'))
	assert.ok(!context.includes('Intro paragraph one.'))
})

hookTest('a heading with a numbered list of questions stays together in the closing block', ({ dir, run }) => {
	const response = 'Summary of the work.\n\n## Your decisions\n1. Drop section three?\n2. Keep the cap?'
	const context = contextOf(run(PROGRESS, startOf(dir), '', withDocuments(turn('turn-1', 10, 'prompt', response))))
	assert.ok(context.includes('## Your decisions\n1. Drop section three?\n2. Keep the cap?'))
	assert.ok(!context.includes('Summary of the work.'))
})

hookTest('a question that only quotes the user does not hide the real ending of a long reply', ({ dir, run }) => {
	const response = `You asked: why place it there?\n\n${textOf('body', 1200)}\n\nSay OK and I will start.`
	const context = contextOf(run(PROGRESS, startOf(dir), '', withDocuments(turn('turn-1', 10, 'prompt', response))))
	assert.ok(context.includes('AI ended: Say OK and I will start.'))
	assert.ok(!context.includes('long closing'))
})

hookTest('when even the last paragraph is too long, the closing block is pointed to', ({ dir, run }) => {
	const lastParagraph = exactText('endbody', LONG_ENTRY + 100)
	const context = contextOf(run(PROGRESS, startOf(dir), '', withDocuments(
		turn('turn-1', 10, 'prompt', `Why?\n\n${lastParagraph}`),
	)))
	assert.ok(context.includes(`(long closing, ${lastParagraph.length} chars: open the note)`))
	assert.ok(!context.includes(lastParagraph.slice(0, 100)))
})

// ---- progress hook: whole entries and size ----

hookTest('a prompt and a closing block under the entry limit are printed whole', ({ dir, run }) => {
	const prompt = textOf('prompt', LONG_ENTRY - 100)
	const closing = `${textOf('closing', LONG_ENTRY - 101)}?`
	const context = contextOf(run(PROGRESS, startOf(dir), '', withDocuments(
		turn('turn-1', 10, prompt, `Intro paragraph.\n\n${closing}`),
	)))
	assertInOrder(context, ['doc=turn-1', prompt, closing])
})

hookTest('a prompt over the entry limit becomes a pointer with its id and size, and the closing block is still printed', ({ dir, run }) => {
	const prompt = textOf('bigprompt', LONG_ENTRY + 100)
	const context = contextOf(run(PROGRESS, startOf(dir), '', withDocuments(
		turn('turn-1', 10, prompt, 'Short reply.\n\nReady to go?'),
	)))
	assert.ok(context.includes('doc=turn-1'))
	assert.ok(context.includes(String(prompt.length)))
	assert.ok(!context.includes(prompt.slice(0, 100)))
	assert.ok(context.includes('Ready to go?'))
})

hookTest('a closing block over the entry limit becomes a pointer with its size, and the prompt is still printed', ({ dir, run }) => {
	const closing = `${textOf('bigclosing', LONG_ENTRY + 100)}?`
	const context = contextOf(run(PROGRESS, startOf(dir), '', withDocuments(
		turn('turn-1', 10, 'A short question', `Intro paragraph.\n\n${closing}`),
	)))
	assert.ok(context.includes('A short question'))
	assert.ok(context.includes(String(closing.length)))
	assert.ok(!context.includes(closing.slice(0, 100)))
})

// Four turns, four AI notes and ten facts, set up so that both lists of 5 hold every turn and every AI note.
const crowdedWork = ({ promptSize, closingSize, titleSize = 0 }) => ({
	turns: [1, 2, 3, 4].map((n) =>
		turn(`turn-${n}`, 10 - n, textOf(`p${n}`, promptSize), `Intro.\n\n${textOf(`c${n}`, closingSize - 1)}?`, 60 - n)),
	aiNotes: ['alpha', 'beta', 'gamma', 'delta'].map((name, i) =>
		aiNote(`note-${name}`, `HANDOFF ${name} ${textOf(name, titleSize)}`.trimEnd(), 50 - i, 20 - i)),
	facts: Array.from({ length: 10 }, (_, i) => item(`f${i}`, textOf(`fact${i}`, 238))),
})
const crowdedEnv = ({ turns, aiNotes, facts }) => ({ ...withDocuments(...turns, ...aiNotes), ...withProfile({ facts }) })

hookTest('on Codex, when the output is too big the recent facts are dropped first, from the end, and no entry is cut', ({ dir, run }) => {
	const work = crowdedWork({ promptSize: 700, closingSize: 700 })
	const context = contextOf(run(PROGRESS, startOf(dir), '', { ...CODEX, ...crowdedEnv(work) }))
	assert.ok(context.length <= 7000, `printed ${context.length} characters`)
	assert.deepEqual(turnsIn(context), ['turn-1', 'turn-2', 'turn-3', 'turn-4'])
	for (const n of [1, 2, 3, 4]) assert.ok(context.includes(textOf(`p${n}`, 700)))
	assert.ok(context.includes(work.facts[0].memory))
	assert.ok(!context.includes(work.facts[9].memory.slice(0, 60)))
	const shown = work.facts.filter((fact) => context.includes(fact.memory))
	assert.deepEqual(shown, work.facts.slice(0, shown.length))
	for (const name of ['alpha', 'beta', 'gamma', 'delta']) assert.ok(context.includes(`doc=note-${name}`))
})

hookTest('on Claude Code the same input keeps all its facts, because the page has more room', ({ dir, run }) => {
	const work = crowdedWork({ promptSize: 700, closingSize: 700 })
	const context = contextOf(run(PROGRESS, startOf(dir), '', { ...CLAUDE_CODE, ...crowdedEnv(work) }))
	assert.ok(context.length > 7000 && context.length <= 9500, `printed ${context.length} characters`)
	for (const fact of work.facts) assert.ok(context.includes(fact.memory))
})

for (const [name, client, limit] of CLIENTS.filter(([, , pageLimit]) => pageLimit === 7000)) {
	hookTest(`on ${name} the worst case keeps the pointers and the newest turn, and drops the oldest turn after the facts`, ({ dir, run }) => {
		const work = crowdedWork({ promptSize: LONG_ENTRY, closingSize: LONG_ENTRY, titleSize: 190 })
		const context = contextOf(run(PROGRESS, startOf(dir), '', { ...client, ...crowdedEnv(work) }))
		assert.ok(context.length <= limit, `printed ${context.length} characters`)
		const shown = turnsIn(context)
		assert.equal(shown[0], 'turn-1')
		assert.ok(!shown.includes('turn-4'))
		assert.deepEqual(shown, ['turn-1', 'turn-2', 'turn-3'].slice(0, shown.length))
		for (const name of ['alpha', 'beta', 'gamma', 'delta']) assert.ok(context.includes(`doc=note-${name}`))
		assert.ok(context.includes(textOf('p1', LONG_ENTRY)))
	})
}

hookTest('on Claude Code the worst case still fits its page and keeps every turn', ({ dir, run }) => {
	const work = crowdedWork({ promptSize: LONG_ENTRY, closingSize: LONG_ENTRY, titleSize: 190 })
	const context = contextOf(run(PROGRESS, startOf(dir), '', { ...CLAUDE_CODE, ...crowdedEnv(work) }))
	assert.ok(context.length <= 9500, `printed ${context.length} characters`)
	assert.deepEqual(turnsIn(context), ['turn-1', 'turn-2', 'turn-3', 'turn-4'])
})

// ---- progress hook: skips are shown, then skipped ----

hookTest('a note that cannot be read is reported with its error and skipped, and the rest is printed', ({ dir, run, failures }) => {
	const result = run(PROGRESS, startOf(dir), '', {
		FAKE_FAIL_ID: 'turn-2',
		...withDocuments(
			turn('turn-1', 30, 'prompt one', 'closing one?'),
			turn('turn-2', 20, 'prompt two', 'closing two?'),
			turn('turn-3', 10, 'prompt three', 'closing three?'),
		),
	})
	const context = contextOf(result)
	assert.deepEqual(turnsIn(context), ['turn-1', 'turn-3'])
	assert.ok(!context.includes('prompt two'))
	assert.match(result.stderr, /document_get/)
	const [failure] = failures()
	assert.deepEqual([failure.hook, failure.operation, failure.status_code, failure.display], ['context', 'document_get', 500, 'pending'])
})

hookTest('a note that is not a turn note is reported and skipped, and the rest is printed', ({ dir, run, failures }) => {
	const context = contextOf(run(PROGRESS, startOf(dir), '', withDocuments(
		note('turn-1', 'User prompt: looks like a turn', 20, 'Something else entirely'),
		turn('turn-2', 10, 'prompt two', 'closing two?'),
	)))
	assert.deepEqual(turnsIn(context), ['turn-2'])
	const recorded = failures()
	assert.equal(recorded.length, 1)
	assert.match(recorded[0].info, /turn-1.*not a turn note/)
})

hookTest('a failing server stops the progress hook quietly and the failure is recorded', ({ dir, run, message, failures }) => {
	const result = run(PROGRESS, startOf(dir), 'server-error')
	assert.equal(result.stdout, '')
	assert.equal(message(result), undefined)
	assert.deepEqual(failures().map((failure) => [failure.hook, failure.display]), [['context', 'pending']])
})

// ---- progress hook: the cache ----

hookTest('caches the document_add content limit that the backend advertises', ({ dir, run, projectCache }) => {
	run(PROGRESS, startOf(dir), '', { FAKE_ADD_LIMIT: '5000' })
	assert.equal(projectCache().projectId, 42)
	assert.equal(projectCache().addContentMaxChars, 5000)
})

hookTest('removes turn-note files that nobody has touched for a day, in the progress hook only', ({ dir, run }) => {
	const cacheDir = join(dir, '.cache', 'ai-center-hooks')
	mkdirSync(cacheDir, { recursive: true })
	const stale = join(cacheDir, 'turn-notes-stale.json')
	const fresh = join(cacheDir, 'turn-notes-fresh.json')
	writeFileSync(stale, '{}')
	writeFileSync(fresh, '{}')
	const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
	utimesSync(stale, twoDaysAgo, twoDaysAgo)
	run(RULES, startOf(dir))
	assert.equal(existsSync(stale), true)
	run(PROGRESS, startOf(dir))
	assert.equal(existsSync(stale), false)
	assert.equal(existsSync(fresh), true)
})

hookTest('still starts the session when the content limit cannot be read', ({ dir, run, toolCalls, projectCache }) => {
	const result = run(PROGRESS, startOf(dir), 'tools-list-error')
	assert.match(result.stderr, /^document_add limit lookup failed/m)
	assert.equal(projectCache().projectId, 42)
	assert.equal(projectCache().addContentMaxChars, undefined)
	assert.ok(callsOf(toolCalls, 'profile_get').length > 0)
})

hookTest('the progress hook refreshes the cached project and the add limit on every run', ({ dir, run, projectCache }) => {
	run(PROGRESS, startOf(dir), '', { FAKE_ADD_LIMIT: '5000' })
	run(PROGRESS, startOf(dir), '', { FAKE_ADD_LIMIT: '7777' })
	assert.equal(projectCache().addContentMaxChars, 7777)
})

// ---- the edges: where a limit sits exactly ----

const RULES_HEADER = 'ai-center: your rules and culture'
const PROGRESS_HEADER = 'ai-center: where the work stands'
const FACTS_HEADER = 'Recent facts:'
const CODEX_PAGE = 7000
const moreRulesNote = (count) => `(${count} more ${count === 1 ? 'rule' : 'rules'} not shown: call profile_get)`
const fullRules = () => Array.from({ length: 8 }, (_, i) => item(`r${i}`, exactText(`rule${i}`, LONG_ENTRY)))
// Eight rules of the entry limit fill most of the page. The room left for the next one depends on the note's length.
const roomForNextRule = (ruleCount) =>
	CODEX_PAGE - moreRulesNote(ruleCount).length - 1 - (RULES_HEADER.length + 8 * (LONG_ENTRY + 3)) - 3

hookTest('a rule of exactly the entry limit is shown whole, and one character more is left out', ({ dir, run }) => {
	const exact = exactText('exact', LONG_ENTRY)
	const over = exactText('over', LONG_ENTRY + 1)
	const context = contextOf(run(RULES, startOf(dir), '', withProfile({ rules: [item('a', exact), item('b', over)] })))
	assert.ok(context.includes(exact))
	assert.ok(!context.includes(over.slice(0, 100)))
})

hookTest('a prompt of exactly the entry limit is printed whole, and one character more becomes a pointer', ({ dir, run }) => {
	const exact = exactText('exactprompt', LONG_ENTRY)
	const over = exactText('overprompt', LONG_ENTRY + 1)
	const context = contextOf(run(PROGRESS, startOf(dir), '', withDocuments(
		turn('turn-1', 20, exact, 'Reply one?'),
		turn('turn-2', 10, over, 'Reply two?'),
	)))
	assert.ok(context.includes(exact))
	assert.ok(!context.includes(over.slice(0, 100)))
	assert.ok(context.includes(String(LONG_ENTRY + 1)))
})

hookTest('the last rule that exactly fits the page is shown, and no note is added', ({ dir, run }) => {
	const rules = [...fullRules(), item('last', exactText('last', roomForNextRule(9)))]
	const context = contextOf(run(RULES, startOf(dir), '', { ...CODEX, ...withProfile({ rules }) }))
	assert.ok(context.includes(rules[8].memory))
	assert.ok(!context.includes('more rules'))
	assert.ok(context.length <= CODEX_PAGE)
})

hookTest('a rule one character too long for the page is left out, and the note says so', ({ dir, run }) => {
	const rules = [...fullRules(), item('last', exactText('last', roomForNextRule(9) + 1))]
	const context = contextOf(run(RULES, startOf(dir), '', { ...CODEX, ...withProfile({ rules }) }))
	assert.ok(!context.includes(rules[8].memory.slice(0, 60)))
	assert.ok(context.includes('(1 more rule not shown: call profile_get)'))
})

hookTest('a rule that does not fit ends the list, even when a shorter one after it would fit', ({ dir, run }) => {
	const tooBig = item('big', exactText('toobig', roomForNextRule(10) + 1))
	const shortRule = item('short', 'A short rule after the big one.')
	const context = contextOf(run(RULES, startOf(dir), '', { ...CODEX, ...withProfile({ rules: [...fullRules(), tooBig, shortRule] }) }))
	assert.ok(!context.includes(tooBig.memory.slice(0, 60)))
	assert.ok(!context.includes(shortRule.memory))
	assert.ok(context.includes('(2 more rules not shown: call profile_get)'))
})

hookTest('a turn is printed as an id line, an asked line and an AI ended line', ({ dir, run }) => {
	const context = contextOf(run(PROGRESS, startOf(dir), '', withDocuments(
		turn('turn-1', 10, 'Where is the config file stored?', 'It is in the home folder.\n\nShall I open it?'),
	)))
	assert.ok(context.includes('[1] doc=turn-1\nasked: Where is the config file stored?\nAI ended: Shall I open it?'))
})

hookTest('a turn without a reply prints no closing line', ({ dir, run }) => {
	const context = contextOf(run(PROGRESS, startOf(dir), '', withDocuments(
		note('turn-1', 'User prompt: only a prompt here', 10, 'User prompt: only a prompt here'),
	)))
	assert.ok(context.includes('asked: only a prompt here'))
	assert.ok(!context.includes('AI ended'))
})

hookTest('the notes written by the AI are numbered after the turns', ({ dir, run }) => {
	const context = contextOf(run(PROGRESS, startOf(dir), '', withDocuments(
		turn('turn-1', 40, 'prompt one', 'closing one?'),
		turn('turn-2', 39, 'prompt two', 'closing two?'),
		aiNote('note-a', 'HANDOFF alpha', 10, 30),
	)))
	assert.ok(context.includes('[1] doc=turn-1'))
	assert.ok(context.includes('[2] doc=turn-2'))
	assert.ok(context.includes('[3] doc=note-a  HANDOFF alpha'))
})

hookTest('the newest turn stays even when the notes are huge, and the notes go after the older turns', ({ dir, run }) => {
	const work = crowdedWork({ promptSize: 20, closingSize: 20, titleSize: 2000 })
	const context = contextOf(run(PROGRESS, startOf(dir), '', { ...CODEX, ...withDocuments(...work.turns, ...work.aiNotes) }))
	assert.ok(context.length <= CODEX_PAGE, `printed ${context.length} characters`)
	assert.deepEqual(turnsIn(context), ['turn-1'])
	assert.ok(context.includes('doc=note-alpha'))
	assert.ok(!context.includes('doc=note-delta'))
})

// Ten facts whose page is exactly the limit, plus the extra characters given.
const factsFillingThePage = (extra) => {
	const overhead = PROGRESS_HEADER.length + 2 + FACTS_HEADER.length + 10 * 3
	const total = CODEX_PAGE - overhead + extra
	const each = Math.floor(total / 10)
	return Array.from({ length: 10 }, (_, i) => item(`f${i}`, exactText(`fact${i}`, i === 9 ? total - each * 9 : each)))
}

hookTest('a progress page of exactly the limit keeps all its facts', ({ dir, run }) => {
	const facts = factsFillingThePage(0)
	const context = contextOf(run(PROGRESS, startOf(dir), '', { ...CODEX, ...withProfile({ facts }) }))
	assert.equal(context.length, CODEX_PAGE)
	for (const fact of facts) assert.ok(context.includes(fact.memory))
})

hookTest('a progress page one character over the limit drops its last fact', ({ dir, run }) => {
	const facts = factsFillingThePage(1)
	const context = contextOf(run(PROGRESS, startOf(dir), '', { ...CODEX, ...withProfile({ facts }) }))
	assert.ok(context.length <= CODEX_PAGE, `printed ${context.length} characters`)
	for (const fact of facts.slice(0, 9)) assert.ok(context.includes(fact.memory))
	assert.ok(!context.includes(facts[9].memory.slice(0, 60)))
})
