import { mkdir, lstat, chmod } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Durable, private state; callers may still choose an explicit session path. */
export async function importDirectory(home = homedir()) {
  let dir = home
  for (const part of ['.actori', 'imports']) {
    dir = join(dir, part)
    await mkdir(dir, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
    const stat = await lstat(dir)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Actori state directory must be a real private directory.')
    await chmod(dir, 0o700)
  }
  dir = join(dir, randomUUID())
  await mkdir(dir, { mode: 0o700 })
  return dir
}
