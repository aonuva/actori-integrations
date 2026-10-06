#!/usr/bin/env node
import { cp, readdir, mkdir, lstat, readFile, writeFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22+ is required.')
const { values } = parseArgs({ options: { client: { type: 'string' }, help: { type: 'boolean' } } })
if (values.help) { console.log('actori-setup --client claude-code|cursor\nInstalls a durable personal setup-actori skill. Does not change MCP connections.'); process.exit(0) }
if (!['claude-code', 'cursor'].includes(values.client)) throw new Error('Use --client claude-code or --client cursor.')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const target = join(homedir(), values.client === 'cursor' ? '.cursor' : '.claude', 'skills', 'setup-actori')
await mkdir(dirname(target), { recursive: true })
const existing = await lstat(target).catch(e => { if (e.code !== 'ENOENT') throw e; return null })
if (existing) throw new Error('setup-actori already exists. Keep it or move it aside before installing this version. Nothing changed.')
const staging = `${target}.install-${process.pid}`
try {
  await mkdir(staging, { mode: 0o700 })
  await cp(join(root, 'skills/setup-actori'), staging, { recursive: true })
  await cp(join(root, 'scripts'), join(staging, 'scripts/runtime/scripts'), { recursive: true })
  await cp(join(root, 'README.md'), join(staging, 'README.md'))
  await writeFile(join(staging, 'installation.json'), JSON.stringify({ package: pkg.name, version: pkg.version }) + '\n')
  // Never replace an existing skill, including a concurrent installation.
  await mkdir(target)
  for (const entry of await readdir(staging)) await cp(join(staging, entry), join(target, entry), { recursive: true, errorOnExist: true, force: false })
} finally { await rm(staging, { recursive: true, force: true }) }
console.log(`Installed setup-actori ${pkg.version} for ${values.client}. Restart your client. MCP connections are unchanged.`)
