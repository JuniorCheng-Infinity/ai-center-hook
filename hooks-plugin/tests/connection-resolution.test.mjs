import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findRegisteredAncestor, writeCodexProjectConnection, resolveConnection } from '../scripts/lib/connection/client-connections.mjs'

test('findRegisteredAncestor walks up within a repo but never past its .git boundary', () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-center-conn-test-'))
  try {
    const repo = join(root, 'repo')
    const backend = join(repo, 'backend')
    const deep = join(backend, 'deep')
    const otherRepo = join(root, 'other-repo')
    for (const dir of [repo, backend, deep, otherRepo]) mkdirSync(dir, { recursive: true })
    mkdirSync(join(repo, '.git'))
    mkdirSync(join(otherRepo, '.git'))

    const server = { url: 'http://test.invalid/mcp', headers: { Authorization: 'Bearer test-key' } }
    const config = { projects: { [repo]: { mcpServers: { 'ai-center': server } } } }

    assert.deepEqual(findRegisteredAncestor(config, repo), server)
    assert.deepEqual(findRegisteredAncestor(config, backend), server)
    assert.deepEqual(findRegisteredAncestor(config, deep), server)
    assert.equal(findRegisteredAncestor(config, otherRepo), undefined)

    // A registration on a shared parent that merely contains the repo must
    // never be picked up from inside the repo — the .git boundary at `repo`
    // stops the walk before it could ever reach `root`.
    const strayConfig = { projects: { [root]: { mcpServers: { 'ai-center': server } } } }
    assert.equal(findRegisteredAncestor(strayConfig, backend), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('findRegisteredAncestor never climbs outside a git repo at all', () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-center-conn-test-nogit-'))
  try {
    const parent = join(root, 'scratch')
    const child = join(parent, 'nested')
    mkdirSync(child, { recursive: true }) // no .git anywhere under root

    const server = { url: 'http://test.invalid/mcp', headers: { Authorization: 'Bearer test-key' } }

    // Registered at the exact starting directory: always trusted, git or not.
    const exactConfig = { projects: { [child]: { mcpServers: { 'ai-center': server } } } }
    assert.deepEqual(findRegisteredAncestor(exactConfig, child), server)

    // Registered one level up, but with no .git anywhere: must NOT be found —
    // there is no boundary proving `child` and `parent` belong together.
    const ancestorConfig = { projects: { [parent]: { mcpServers: { 'ai-center': server } } } }
    assert.equal(findRegisteredAncestor(ancestorConfig, child), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('writeCodexProjectConnection merges without disturbing unrelated settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-center-codex-write-test-'))
  try {
    writeCodexProjectConnection(dir, { baseUrl: 'http://first.invalid', apiKey: 'key-one' })
    let content = readFileSync(join(dir, '.codex', 'config.toml'), 'utf8')
    assert.match(content, /url = "http:\/\/first\.invalid\/mcp"/)
    assert.match(content, /Authorization = "Bearer key-one"/)

    // Add an unrelated setting by hand, the way a user's own config would have it.
    writeFileSync(join(dir, '.codex', 'config.toml'), `[model]\nname = "o3"\n\n${content}`)

    // Overwrite with a new connection: old ai-center section replaced, model setting survives.
    writeCodexProjectConnection(dir, { baseUrl: 'http://second.invalid', apiKey: 'key-two' })
    content = readFileSync(join(dir, '.codex', 'config.toml'), 'utf8')
    assert.match(content, /name = "o3"/)
    assert.match(content, /url = "http:\/\/second\.invalid\/mcp"/)
    assert.match(content, /Authorization = "Bearer key-two"/)
    assert.doesNotMatch(content, /first\.invalid/)
    assert.doesNotMatch(content, /key-one/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveConnection prefers a project-local Codex config over the global one, bounded by .git', () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-center-codex-walk-test-'))
  try {
    const repo = join(root, 'repo')
    const nested = join(repo, 'nested')
    mkdirSync(nested, { recursive: true })
    mkdirSync(join(repo, '.git'))

    const codexHome = join(root, 'codex-home')
    mkdirSync(codexHome, { recursive: true })
    writeFileSync(join(codexHome, 'config.toml'), '[mcp_servers.ai-center]\nurl = "http://global.invalid/mcp"\n\n[mcp_servers.ai-center.http_headers]\nAuthorization = "Bearer global-key"\n')

    writeCodexProjectConnection(repo, { baseUrl: 'http://project-local.invalid', apiKey: 'project-key' })

    const env = { ...process.env, PLUGIN_ROOT: '/fake/.codex/plugins/cache/x', CODEX_HOME: codexHome }
    delete env.CLAUDECODE
    delete env.AI_CENTER_BASE_URL
    delete env.AI_CENTER_API_KEY
    const originalEnv = { ...process.env }
    Object.assign(process.env, env)
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]
    try {
      // From the repo root and from a nested subdirectory: both find the project-local file.
      assert.deepEqual(resolveConnection({ cwd: repo, projectDir: repo }), { baseUrl: 'http://project-local.invalid', apiKey: 'project-key' })
      assert.deepEqual(resolveConnection({ cwd: nested, projectDir: nested }), { baseUrl: 'http://project-local.invalid', apiKey: 'project-key' })
      // Outside any repo with a project-local file: falls back to the global one.
      assert.deepEqual(resolveConnection({ cwd: root, projectDir: root }), { baseUrl: 'http://global.invalid', apiKey: 'global-key' })
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key]
      Object.assign(process.env, originalEnv)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
