import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connectionFormatter } from '../scripts/lib/connection/client-connections.mjs'

test('takes the key out of the Bearer header and cuts the url down to its origin', () => {
	assert.deepEqual(connectionFormatter('http://localhost:3000/mcp', 'Bearer abc'), {
		baseUrl: 'http://localhost:3000',
		apiKey: 'abc',
	})
})

test('treats the short /mcp and the old /api/client/mcp suffix alike, with or without a trailing slash', () => {
	const expected = { baseUrl: 'https://memory.example.com', apiKey: 'k' }
	assert.deepEqual(connectionFormatter('https://memory.example.com/api/client/mcp', 'Bearer k'), expected)
	assert.deepEqual(connectionFormatter('https://memory.example.com/api/client/mcp/', 'Bearer k'), expected)
	assert.deepEqual(connectionFormatter('https://memory.example.com/mcp/', 'Bearer k'), expected)
})

test('accepts a key that has no Bearer prefix, as an environment variable gives it', () => {
	assert.deepEqual(connectionFormatter('http://h/mcp', 'abc'), { baseUrl: 'http://h', apiKey: 'abc' })
})

test('reads the Bearer word in any case', () => {
	assert.equal(connectionFormatter('http://h/mcp', 'bearer abc').apiKey, 'abc')
})

test('gives nothing when the url or the key is missing', () => {
	assert.equal(connectionFormatter(undefined, 'Bearer a'), undefined)
	assert.equal(connectionFormatter('', 'Bearer a'), undefined)
	assert.equal(connectionFormatter('http://h/mcp', undefined), undefined)
	assert.equal(connectionFormatter('http://h/mcp', 'Bearer '), undefined)
})
