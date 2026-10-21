import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readHead, readTail } from '../scripts/lib/hook-utils.mjs'

function withFile(content, run) {
	const dir = mkdtempSync(join(tmpdir(), 'ai-center-read-test-'))
	try {
		const path = join(dir, 'file.txt')
		writeFileSync(path, content)
		return run(path)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

test('readHead returns the first bytes of a file', () => {
	assert.equal(withFile('0123456789', (path) => readHead(path, 4)), '0123')
})

test('readTail returns the last bytes of a file', () => {
	assert.equal(withFile('0123456789', (path) => readTail(path, 4)), '6789')
})

test('a limit larger than the file gives the whole file', () => {
	assert.equal(withFile('0123456789', (path) => readHead(path, 1000)), '0123456789')
	assert.equal(withFile('0123456789', (path) => readTail(path, 1000)), '0123456789')
})

test('an empty file gives an empty text', () => {
	assert.equal(withFile('', (path) => readHead(path, 10)), '')
	assert.equal(withFile('', (path) => readTail(path, 10)), '')
})

test('a multi-byte character cut at the boundary does not throw and keeps the rest', () => {
	// The euro sign is three bytes, so a cut of three bytes lands inside it.
	const content = 'ab€cd'
	assert.ok(withFile(content, (path) => readHead(path, 3)).startsWith('ab'))
	assert.ok(withFile(content, (path) => readTail(path, 4)).endsWith('cd'))
})

test('exactly the size of the file gives the whole file for both', () => {
	const content = 'hello'
	assert.equal(withFile(content, (path) => readHead(path, 5)), 'hello')
	assert.equal(withFile(content, (path) => readTail(path, 5)), 'hello')
})
