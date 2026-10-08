import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const cli = new URL('../../scripts/mcp-import.mjs', import.meta.url)
test('removed session commands fail without contacting a server', () => {
  for (const command of ['start', 'status', 'resume', 'finish', 'launch']) {
    const result = spawnSync(process.execPath, [cli.pathname, command], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /retired command/)
    assert.equal(result.stdout, '')
  }
})
