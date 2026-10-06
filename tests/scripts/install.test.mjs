import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, cp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
for (const client of ['claude-code', 'cursor']) test(`durable ${client} installation survives package removal and refuses overwrite`, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'actori-install-')); t.after(() => rm(dir, { recursive: true, force: true }))
  const root = join(dir, 'package'), home = join(dir, 'home'); await mkdir(root); await mkdir(home)
  for (const p of ['scripts', 'skills', 'package.json', 'README.md']) await cp(resolve(p), join(root,p), { recursive:true })
  const env = {...process.env, HOME:home, USERPROFILE:home}
  const installer = join(root,'scripts/install-setup-skill.mjs')
  execFileSync(process.execPath,[installer,'--client',client],{env})
  assert.throws(() => execFileSync(process.execPath,[installer,'--client',client],{env,stdio:'pipe'}))
  await rm(root,{recursive:true})
  const skill=join(home,client==='cursor'?'.cursor':'.claude','skills/setup-actori')
  assert.match(execFileSync(process.execPath,[join(skill,'scripts/import.mjs'),'--help'],{env,encoding:'utf8'}),/Actori MCP/)
  assert.equal(JSON.parse(await readFile(join(skill,'installation.json'),'utf8')).version,'0.1.1')
  // Referenced guidance must survive standalone installation with the runtime.
  const instructions = await readFile(join(skill, 'SKILL.md'), 'utf8')
  const references = [...instructions.matchAll(/\]\((references\/[^)]+)\)/g)].map(m => m[1])
  assert.ok(references.length > 0)
  for (const reference of references) assert.ok((await readFile(join(skill, reference), 'utf8')).length > 0)
})
