import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promptFormatter, usageFormatter } from '../scripts/lib/note/field-formatter.mjs'

test('promptFormatter leaves a single prompt exactly as it is', () => {
	assert.equal(promptFormatter(['fix the login bug']), 'fix the login bug')
})

test('promptFormatter numbers several prompts, one per line, starting on a new line', () => {
	assert.equal(promptFormatter(['fix the login bug', 'also add a test']), '\n1. fix the login bug\n2. also add a test')
})

test('promptFormatter gives nothing for no prompt', () => {
	assert.equal(promptFormatter([]), '')
	assert.equal(promptFormatter(), '')
})

test('usageFormatter puts tools, skills and MCP tools on their own lines, each name once, in first-use order', () => {
	const text = usageFormatter({
		tools: ['Read', 'Bash', 'Read'],
		skills: ['ecc:tdd-workflow'],
		mcp: ['mcp__ai-center__memory_search', 'mcp__ai-center__memory_search'],
	})
	assert.equal(text, 'tool: Read, Bash\nskill: ecc:tdd-workflow\nmcp: mcp__ai-center__memory_search')
})

test('usageFormatter leaves out a line that has no names', () => {
	assert.equal(usageFormatter({ mcp: ['mcp__a__b'] }), 'mcp: mcp__a__b')
	assert.equal(usageFormatter({ tools: ['Read'], skills: ['a'] }), 'tool: Read\nskill: a')
})

test('usageFormatter gives nothing when nothing was used', () => {
	assert.equal(usageFormatter({ tools: [], skills: [], mcp: [] }), '')
	assert.equal(usageFormatter(), '')
})
