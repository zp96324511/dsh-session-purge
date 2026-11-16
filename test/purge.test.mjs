/**
 * dsh-session-purge 的单元测试。
 *
 * 全程在 `mkdtemp` 的临时 DSH home 里跑，不接触真实的 `~/.dsh`。
 * 覆盖 HANDOFF.md 第 9.1 节的用例表：路径逃逸、符号链接、家族保护、
 * 30/7 天两条保留期、恢复、guard 失败、锁。
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

import {
  LockBusyError,
  acquireLock,
  entryNameFor,
  formatBytes,
  isInside,
  isSessionId,
  moveOne,
  normalizeConfig,
  planMoves,
  purgeTrash,
  readJson,
  resolveSessionDir,
  restoreEntry,
  runOnce,
  segmentsUnder,
  utcCompact,
  validateConfig,
  version,
} from '../index.js'

const DAY = 86_400_000
const PKG = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

/** 合法会话 id（`session-<uuid>`，全小写十六进制）。 */
function newSessionId() {
  return `session-${randomUUID()}`
}

async function makeHome() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-session-purge-'))
  await mkdir(path.join(home, 'sessions'), { recursive: true })
  return home
}

/** 一套指向临时 home 的显式配置（不依赖 $DSH_HOME）。 */
function configFor(home, extra = {}) {
  return normalizeConfig(
    {
      sessionsRoot: path.join(home, 'sessions'),
      projectionCacheDir: path.join(home, 'storages', 'session_projcache', 'sessions'),
      workspaceStorePath: path.join(home, 'storages', 'workspace.json'),
      scheduleStorePath: path.join(home, 'storages', 'schedule.json'),
      trashRoot: path.join(home, 'session-purge', 'trash'),
      statePath: path.join(home, 'session-purge', 'state.json'),
      logFile: path.join(home, 'logs', 'session-purge.log'),
      startupDelayMs: 0,
      ...extra,
    },
    home,
  )
}

/** 造一个会话目录 + 投影缓存 + 对应的 persistence 快照。 */
async function addSession(
  config,
  { id = newSessionId(), workspaceDir = '--test-workspace--', ageDays = 40, parent = null, cache = true, content = 'hello\n' } = {},
) {
  const dir = path.join(config.sessionsRoot, workspaceDir, id)
  await mkdir(dir, { recursive: true })
  const artifact = path.join(dir, 'session.v4.jsonl.zstd')
  await writeFile(artifact, content)
  const when = new Date(Date.now() - ageDays * DAY)
  await utimes(artifact, when, when)

  let cachePath = null
  if (cache) {
    cachePath = path.join(config.projectionCacheDir, `${id}.json`)
    await mkdir(path.dirname(cachePath), { recursive: true })
    await writeFile(cachePath, JSON.stringify({ header: { id } }), 'utf8')
  }

  const snapshot = {
    header: {
      version: 4,
      id,
      createdAt: new Date(Date.now() - (ageDays + 3) * DAY).toISOString(),
      cwd: 'C:\\test',
      ...(parent === null ? {} : { parentSession: parent }),
    },
    location: { kind: 'jsonl', path: artifact },
    sizeBytes: content.length,
    revision: 'r1',
  }
  return { id, dir, artifact, cachePath, snapshot, workspaceDir }
}

/** 假 ctx：只要 `get(name)` 能拿到四个服务就够了。 */
function ctxStub({ snapshots = [], archived = [], pinned = [], live = [], tasks = [], catalogThrows = false } = {}) {
  const services = {
    sessionPersistence: { list: async () => snapshots },
    workspaceRegistry: {
      get archivedSessionIds() {
        return archived
      },
      get pinnedSessionIds() {
        return pinned
      },
    },
    sessions: { list: () => live.map((id) => ({ id })) },
    schedule: {
      catalog: async () => {
        if (catalogThrows) throw new Error('schedule catalog 不可用')
        return tasks
      },
    },
  }
  return { get: (name) => services[name], logger: undefined }
}

async function exists(target) {
  try {
    await stat(target)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function entryNames(config) {
  return readdir(config.trashRoot).catch((error) => {
    if (error?.code === 'ENOENT') return []
    throw error
  })
}

/** 造一个回收站条目，`ageDays` 天前移动。 */
async function addTrashEntry(config, { id = newSessionId(), ageDays = 8, state = 'complete', meta = true } = {}) {
  const movedAt = new Date(Date.now() - ageDays * DAY)
  const entryName = entryNameFor(movedAt.getTime(), id)
  const entryDir = path.join(config.trashRoot, entryName)
  await mkdir(path.join(entryDir, 'session'), { recursive: true })
  await writeFile(path.join(entryDir, 'session', 'session.v4.jsonl.zstd'), 'payload')
  if (meta) {
    await writeFile(
      path.join(entryDir, 'meta.json'),
      JSON.stringify({
        version: 1,
        state,
        sessionId: id,
        originalSessionDir: path.join(config.sessionsRoot, '--test-workspace--', id),
        originalArtifact: path.join(config.sessionsRoot, '--test-workspace--', id, 'session.v4.jsonl.zstd'),
        originalProjectionCache: null,
        movedAt: movedAt.toISOString(),
        purgeAfter: new Date(movedAt.getTime() + 7 * DAY).toISOString(),
      }),
      'utf8',
    )
  } else {
    /* 没有 meta：清理时用条目目录 mtime 兜底，所以这里要把目录时间也拨回去。 */
    await utimes(entryDir, movedAt, movedAt)
  }
  return { id, entryName, entryDir, movedAt }
}

/* ------------------------------------------------------------------ */
/* 元数据与配置                                                        */
/* ------------------------------------------------------------------ */

test('package.json 与 index.js 的版本/入口一致', () => {
  assert.equal(version, PKG.version)
  assert.equal(PKG.type, 'module')
  assert.equal(PKG.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(PKG.exports['.'], './index.js')
})

test('normalizeConfig：缺省值来自 DSH home', () => {
  const config = normalizeConfig({}, path.join(os.tmpdir(), 'fake-home'))
  assert.equal(config.enabled, true)
  assert.equal(config.dryRun, true, '默认必须 dry-run')
  assert.equal(config.archiveRetentionDays, 30)
  assert.equal(config.trashRetentionDays, 7)
  assert.equal(config.intervalMinutes, 1440)
  assert.equal(config.startupDelayMs, 60_000)
  assert.equal(config.maxMovesPerRun, 50)
  assert.equal(config.moveProjectionCache, true)
  assert.equal(config.trashRoot, path.resolve(os.tmpdir(), 'fake-home', 'session-purge', 'trash'))
  assert.equal(config.statePath, path.resolve(os.tmpdir(), 'fake-home', 'session-purge', 'state.json'))
  assert.equal(config.logFile, path.resolve(os.tmpdir(), 'fake-home', 'logs', 'session-purge.log'))
})

test('normalizeConfig：显式配置优先，数值被夹紧', () => {
  const config = normalizeConfig(
    {
      dryRun: false,
      archiveRetentionDays: -5,
      trashRetentionDays: '9',
      intervalMinutes: 0,
      maxMovesPerRun: 12.9,
      trashRoot: 'D:\\purge\\trash',
    },
    'C:\\home',
  )
  assert.equal(config.dryRun, false)
  assert.equal(config.archiveRetentionDays, 0, '负数夹到 0')
  assert.equal(config.trashRetentionDays, 9)
  assert.equal(config.intervalMinutes, 1, '间隔至少 1 分钟')
  assert.equal(config.maxMovesPerRun, 12, '整数取整')
  assert.equal(config.trashRoot, path.resolve('D:\\purge\\trash'))
})

test('validateConfig：回收站不能放在 sessions 下', () => {
  const home = path.join(os.tmpdir(), 'fake-home-2')
  const good = normalizeConfig({}, home)
  assert.deepEqual(validateConfig(good), [])

  const bad = normalizeConfig({ trashRoot: path.join(good.sessionsRoot, 'purge', 'trash') }, home)
  assert.equal(validateConfig(bad).length, 1)
  assert.match(validateConfig(bad)[0], /sessionsRoot/)
})

test('路径助手：isInside / segmentsUnder / 条目命名', () => {
  const root = path.resolve(os.tmpdir(), 'root')
  assert.equal(isInside(root, path.join(root, 'a', 'b')), true)
  assert.equal(isInside(root, root), false)
  assert.equal(isInside(root, path.join(root, '..', 'escape')), false)
  assert.deepEqual(segmentsUnder(root, path.join(root, 'ws', 'session-x', 'file')), ['ws', 'session-x', 'file'])
  assert.equal(segmentsUnder(root, path.join(root, '..', 'escape')), null)

  const id = newSessionId()
  assert.match(entryNameFor(Date.UTC(2026, 10, 13, 1, 45, 0, 123), id), /^20261113T014500123Z__session-/)
  assert.equal(utcCompact(Date.UTC(2026, 0, 2, 3, 4, 5, 6)), '20260102T030405006Z')
  assert.equal(isSessionId(id), true)
  assert.equal(isSessionId('session-not-a-uuid'), false)
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(1536), '1.5 KB')
})

/* ------------------------------------------------------------------ */
/* 路径校验                                                            */
/* ------------------------------------------------------------------ */

test('resolveSessionDir：正常会话通过并返回目录信息', async () => {
  const home = await makeHome()
  const config = configFor(home)
  const session = await addSession(config)
  const resolved = await resolveSessionDir(config, session.snapshot)
  assert.equal(resolved.ok, true)
  assert.equal(resolved.sessionId, session.id)
  assert.equal(resolved.sessionDir, session.dir)
  assert.equal(resolved.workspaceDirName, session.workspaceDir)
  assert.equal(resolved.sizeBytes, 'hello\n'.length)
  assert.ok(resolved.mtimeMs < Date.now() - 30 * DAY)
})

test('resolveSessionDir：非法 id / 文件名 / 目录名 / 深度 / 逃逸都被拒绝', async () => {
  const home = await makeHome()
  const config = configFor(home)
  const session = await addSession(config)

  const badId = await resolveSessionDir(config, {
    ...session.snapshot,
    header: { ...session.snapshot.header, id: 'session-nope' },
  })
  assert.equal(badId.ok, false)
  assert.equal(badId.reason, 'bad-session-id')

  const badName = await resolveSessionDir(config, {
    ...session.snapshot,
    location: { kind: 'jsonl', path: path.join(session.dir, 'notes.txt') },
  })
  assert.equal(badName.ok, false)
  assert.equal(badName.reason, 'bad-artifact-name')

  const wrongDir = path.join(config.sessionsRoot, session.workspaceDir, newSessionId())
  await mkdir(wrongDir, { recursive: true })
  const movedArtifact = path.join(wrongDir, 'session.v4.jsonl.zstd')
  await writeFile(movedArtifact, 'x')
  const dirMismatch = await resolveSessionDir(config, {
    header: { id: session.id },
    location: { kind: 'jsonl', path: movedArtifact },
  })
  assert.equal(dirMismatch.ok, false)
  assert.equal(dirMismatch.reason, 'dir-name-mismatch')

  const tooDeep = path.join(config.sessionsRoot, session.workspaceDir, 'nested', session.id, 'session.v4.jsonl.zstd')
  const depth = await resolveSessionDir(config, {
    header: { id: session.id },
    location: { kind: 'jsonl', path: tooDeep },
  })
  assert.equal(depth.ok, false)
  assert.equal(depth.reason, 'unexpected-depth')

  const escapePath = path.join(config.sessionsRoot, '..', session.id, 'session.v4.jsonl.zstd')
  const escape = await resolveSessionDir(config, {
    header: { id: session.id },
    location: { kind: 'jsonl', path: escapePath },
  })
  assert.equal(escape.ok, false)
  assert.equal(escape.reason, 'outside-sessions-root')

  const noLocation = await resolveSessionDir(config, { header: { id: session.id } })
  assert.equal(noLocation.ok, false)
  assert.equal(noLocation.reason, 'no-jsonl-location')
})

test('resolveSessionDir：符号链接/junction 被拒绝', async (t) => {
  const home = await makeHome()
  const config = configFor(home)
  const target = await addSession(config, { workspaceDir: '--real--' })
  const linkParent = path.join(config.sessionsRoot, '--linked--')
  await mkdir(linkParent, { recursive: true })
  const linkDir = path.join(linkParent, target.id)
  let created = false
  try {
    await symlink(target.dir, linkDir, 'junction')
    created = true
  } catch {
    /* 没有 Developer Mode 时 Node 的 symlink 会 EPERM；junction 用 mklink 通常免管理员。 */
    try {
      await execFileAsync('cmd.exe', ['/c', 'mklink', '/J', linkDir, target.dir])
      created = true
    } catch (error) {
      t.skip(`当前环境不能创建 junction：${error.message}`)
      return
    }
  }
  assert.equal(created, true)
  const resolved = await resolveSessionDir(config, {
    header: { id: target.id },
    location: { kind: 'jsonl', path: path.join(linkDir, 'session.v4.jsonl.zstd') },
  })
  assert.equal(resolved.ok, false)
  assert.equal(resolved.reason, 'session-dir-unusable')
})

/* ------------------------------------------------------------------ */
/* 计划                                                                */
/* ------------------------------------------------------------------ */

test('planMoves：未归档、未到期、受保护、无快照分别跳过', async () => {
  const home = await makeHome()
  const config = configFor(home)
  const fresh = await addSession(config, { ageDays: 3 })
  const old = await addSession(config, { ageDays: 40 })
  const pinned = await addSession(config, { ageDays: 40 })
  const live = await addSession(config, { ageDays: 40 })
  const scheduled = await addSession(config, { ageDays: 40 })
  const missing = newSessionId()

  const plan = await planMoves({
    config,
    snapshots: [fresh.snapshot, old.snapshot, pinned.snapshot, live.snapshot, scheduled.snapshot],
    archived: new Set([fresh.id, old.id, pinned.id, live.id, scheduled.id, missing]),
    protectedIds: new Set([pinned.id, live.id, scheduled.id]),
  })

  assert.deepEqual(plan.candidates.map((candidate) => candidate.sessionId), [old.id])
  assert.equal(plan.eligible, 1)
  assert.equal(plan.scanned, 5)
  assert.equal(plan.archivedCount, 6)
  assert.equal(plan.reasons['not-eligible'], 1)
  assert.equal(plan.reasons.protected, 3)
  assert.equal(plan.reasons['no-snapshot'], 1)
})

test('planMoves：父老子新 → 整族都不动', async () => {
  const home = await makeHome()
  const config = configFor(home)
  const parent = await addSession(config, { ageDays: 60 })
  const child = await addSession(config, { ageDays: 5, parent: parent.id })

  const plan = await planMoves({
    config,
    snapshots: [parent.snapshot, child.snapshot],
    archived: new Set([parent.id, child.id]),
  })
  assert.deepEqual(plan.candidates, [])
  assert.equal(plan.reasons['family-mixed'], 1, '父会话被家族规则拦下')
  assert.equal(plan.reasons['not-eligible'], 1, '子会话本身未到期')
})

test('planMoves：父子都老 → 都移，子先父后', async () => {
  const home = await makeHome()
  const config = configFor(home)
  const parent = await addSession(config, { ageDays: 60 })
  const child = await addSession(config, { ageDays: 40, parent: parent.id })

  const plan = await planMoves({
    config,
    snapshots: [parent.snapshot, child.snapshot],
    archived: new Set([parent.id, child.id]),
  })
  assert.deepEqual(
    plan.candidates.map((candidate) => candidate.sessionId),
    [child.id, parent.id],
    'depth 降序：子会话先进回收站',
  )
  assert.equal(plan.candidates[0].depth, 1)
  assert.equal(plan.candidates[1].depth, 0)
  assert.deepEqual(plan.candidates[1].childIds, [child.id])
})

test('planMoves：maxMovesPerRun 截断会拆散家族 → 整族留下', async () => {
  const home = await makeHome()
  const config = configFor(home)
  const parent = await addSession(config, { ageDays: 60 })
  const child = await addSession(config, { ageDays: 40, parent: parent.id })

  const plan = await planMoves({
    config,
    snapshots: [parent.snapshot, child.snapshot],
    archived: new Set([parent.id, child.id]),
    limit: 1,
  })
  assert.deepEqual(plan.candidates, [])
  assert.equal(plan.reasons['family-truncated'], 1)
  assert.equal(plan.eligible, 2)
})

test('planMoves：路径逃逸的会话被拒绝', async () => {
  const home = await makeHome()
  const config = configFor(home)
  const outside = path.join(home, 'outside', newSessionId())
  await mkdir(outside, { recursive: true })
  const artifact = path.join(outside, 'session.v4.jsonl.zstd')
  await writeFile(artifact, 'x')
  const id = path.basename(outside)
  const plan = await planMoves({
    config,
    snapshots: [
      {
        header: { version: 4, id },
        location: { kind: 'jsonl', path: artifact },
      },
    ],
    archived: new Set([id]),
  })
  assert.deepEqual(plan.candidates, [])
  assert.equal(plan.reasons['outside-sessions-root'], 1)
})

/* ------------------------------------------------------------------ */
/* 移动                                                                */
/* ------------------------------------------------------------------ */

test('moveOne：会话目录与投影缓存整体进回收站', async () => {
  const home = await makeHome()
  const config = configFor(home)
  const session = await addSession(config)
  const plan = await planMoves({ config, snapshots: [session.snapshot], archived: new Set([session.id]) })
  assert.equal(plan.candidates.length, 1)

  const result = await moveOne(config, plan.candidates[0])
  assert.equal(result.moved, true)
  assert.equal(await exists(session.dir), false, '原会话目录必须消失')
  assert.equal(await exists(session.cachePath), false, '投影缓存应被移走')
  assert.equal(await exists(path.join(result.entryDir, 'session', 'session.v4.jsonl.zstd')), true)
  assert.equal(await exists(path.join(result.entryDir, 'projection-cache.json')), true)

  const meta = await readJson(path.join(result.entryDir, 'meta.json'))
  assert.equal(meta.state, 'complete')
  assert.equal(meta.sessionId, session.id)
  assert.equal(meta.projectionCacheMoved, true)
  assert.equal(meta.originalSessionDir, session.dir)
  assert.equal(meta.originalProjectionCache, session.cachePath)
  assert.equal(meta.reason, 'archived-and-idle')
  assert.equal(meta.pluginVersion, version)
  assert.ok(Date.parse(meta.purgeAfter) - Date.parse(meta.movedAt) === 7 * DAY)
})

test('moveOne：二次校验发现文件刚被写入 → 不移动', async () => {
  const home = await makeHome()
  const config = configFor(home)
  const session = await addSession(config)
  const plan = await planMoves({ config, snapshots: [session.snapshot], archived: new Set([session.id]) })
  const candidate = plan.candidates[0]

  const now = new Date()
  await utimes(session.artifact, now, now)

  const result = await moveOne(config, candidate)
  assert.equal(result.moved, false)
  assert.equal(result.reason, 'not-eligible')
  assert.equal(await exists(session.dir), true)
  assert.deepEqual(await entryNames(config), [])
})

test('moveOne：没有投影缓存时 meta 记 null', async () => {
  const home = await makeHome()
  const config = configFor(home)
  const session = await addSession(config, { cache: false })
  const plan = await planMoves({ config, snapshots: [session.snapshot], archived: new Set([session.id]) })
  const result = await moveOne(config, plan.candidates[0])
  assert.equal(result.moved, true)
  const meta = await readJson(path.join(result.entryDir, 'meta.json'))
  assert.equal(meta.originalProjectionCache, null)
  assert.equal(meta.projectionCacheMoved, false)
})

/* ------------------------------------------------------------------ */
/* 回收站清理                                                          */
/* ------------------------------------------------------------------ */

test('purgeTrash：6 天保留，8 天删除', async () => {
  const home = await makeHome()
  const config = configFor(home)
  const young = await addTrashEntry(config, { ageDays: 6 })
  const old = await addTrashEntry(config, { ageDays: 8 })

  const result = await purgeTrash(config, { dryRun: false })
  assert.equal(result.purged.length, 1)
  assert.equal(result.kept, 1)
  assert.equal(result.purged[0].entryName, old.entryName)
  assert.equal(await exists(old.entryDir), false)
  assert.equal(await exists(young.entryDir), true)
  assert.ok(result.bytes > 0)
})

test('purgeTrash：dry-run 只报告', async () => {
  const home = await makeHome()
  const config = configFor(home)
  const old = await addTrashEntry(config, { ageDays: 9 })
  const result = await purgeTrash(config, { dryRun: true })
  assert.equal(result.purged.length, 0)
  assert.equal(result.wouldPurge.length, 1)
  assert.equal(await exists(old.entryDir), true)
})

test('purgeTrash：meta 缺失按目录 mtime 兜底；state=moving 也按时清理', async () => {
  const home = await makeHome()
  const config = configFor(home)
  const noMeta = await addTrashEntry(config, { ageDays: 8, meta: false })
  const moving = await addTrashEntry(config, { ageDays: 8, state: 'moving' })
  const freshNoMeta = await addTrashEntry(config, { ageDays: 1, meta: false })

  const result = await purgeTrash(config, { dryRun: false })
  const purged = result.purged.map((record) => record.entryName).sort()
  assert.deepEqual(purged, [noMeta.entryName, moving.entryName].sort())
  assert.equal(await exists(freshNoMeta.entryDir), true)
})

test('purgeTrash：不认识的条目名与符号链接不碰', async (t) => {
  const home = await makeHome()
  const config = configFor(home)
  const stranger = path.join(config.trashRoot, 'not-ours')
  await mkdir(stranger, { recursive: true })
  const when = new Date(Date.now() - 30 * DAY)
  await utimes(stranger, when, when)

  let linkCreated = false
  const junctionPath = path.join(config.trashRoot, `${utcCompact(Date.now())}__${newSessionId()}`)
  try {
    await symlink(stranger, junctionPath, 'junction')
    linkCreated = true
  } catch {
    try {
      await execFileAsync('cmd.exe', ['/c', 'mklink', '/J', junctionPath, stranger])
      linkCreated = true
    } catch {
      linkCreated = false
    }
  }

  await purgeTrash(config, { dryRun: false })
  assert.equal(await exists(stranger), true, '陌生目录不能被删')
  if (linkCreated) t.diagnostic('junction 已创建且未被跟随删除')
})

/* ------------------------------------------------------------------ */
/* 单轮编排                                                            */
/* ------------------------------------------------------------------ */

test('runOnce：dry-run 不改任何文件，但写 state 与日志', async () => {
  const home = await makeHome()
  const config = configFor(home)
  const session = await addSession(config)
  const stale = await addTrashEntry(config, { ageDays: 9 })
  const ctx = ctxStub({ snapshots: [session.snapshot], archived: [session.id] })

  const summary = await runOnce(ctx, config)
  assert.equal(summary.dryRun, true)
  assert.equal(summary.scanned, 1)
  assert.equal(summary.archived, 1)
  assert.equal(summary.eligible, 1)
  assert.equal(summary.wouldMove, 1)
  assert.equal(summary.wouldPurge, 1)
  assert.equal(summary.moved, 0)
  assert.equal(summary.purged, 0)

  assert.equal(await exists(session.dir), true)
  assert.equal(await exists(session.cachePath), true)
  assert.equal(await exists(stale.entryDir), true)

  const state = await readJson(config.statePath)
  assert.equal(state.lastRun.dryRun, true)
  assert.equal(state.stats.runsTotal, 1)
  assert.equal(state.stats.movedTotal, 0)

  const log = await readFile(config.logFile, 'utf8')
  assert.match(log, /would-move /)
  assert.match(log, /run scanned=1 archived=1 eligible=1 moved=0 purged=0 errors=0 dryRun=true/)
})

test('runOnce：真实移动 + 下一轮清理回收站', async () => {
  const home = await makeHome()
  const config = configFor(home, { dryRun: false })
  const session = await addSession(config)
  const ctx = ctxStub({ snapshots: [session.snapshot], archived: [session.id] })

  const first = await runOnce(ctx, config)
  assert.equal(first.moved, 1)
  assert.equal(first.purged, 0)
  assert.equal(await exists(session.dir), false)
  const entries = await entryNames(config)
  assert.equal(entries.length, 1)

  /* 把这条目改成 8 天前移动，再跑一轮：应被彻底删除。 */
  const metaPath = path.join(config.trashRoot, entries[0], 'meta.json')
  const meta = await readJson(metaPath)
  meta.movedAt = new Date(Date.now() - 8 * DAY).toISOString()
  meta.purgeAfter = new Date(Date.now() - 1 * DAY).toISOString()
  await writeFile(metaPath, JSON.stringify(meta), 'utf8')

  const second = await runOnce(ctx, config)
  assert.equal(second.moved, 0)
  assert.equal(second.purged, 1)
  assert.equal(await exists(path.join(config.trashRoot, entries[0])), false)

  const state = await readJson(config.statePath)
  assert.equal(state.stats.movedTotal, 1)
  assert.equal(state.stats.purgedTotal, 1)
  assert.ok(state.stats.lastRealRunAt !== null)
})

test('runOnce：live / pinned / 定时任务会话绝不移动', async () => {
  const home = await makeHome()
  const config = configFor(home, { dryRun: false })
  const pinned = await addSession(config)
  const live = await addSession(config)
  const scheduled = await addSession(config)
  const plain = await addSession(config)

  const ctx = ctxStub({
    snapshots: [pinned.snapshot, live.snapshot, scheduled.snapshot, plain.snapshot],
    archived: [pinned.id, live.id, scheduled.id, plain.id],
    pinned: [pinned.id],
    live: [live.id],
    tasks: [{ status: 'active', target: { kind: 'session', sessionId: scheduled.id }, involvedSessionIds: [scheduled.id] }],
  })

  const summary = await runOnce(ctx, config)
  assert.equal(summary.moved, 1)
  assert.equal(summary.reasons.protected, 3)
  for (const kept of [pinned, live, scheduled]) assert.equal(await exists(kept.dir), true)
  assert.equal(await exists(plain.dir), false)
})

test('runOnce：paused 任务同样保护；ended 不保护', async () => {
  const home = await makeHome()
  const config = configFor(home, { dryRun: false })
  const paused = await addSession(config)
  const ended = await addSession(config)
  const ctx = ctxStub({
    snapshots: [paused.snapshot, ended.snapshot],
    archived: [paused.id, ended.id],
    tasks: [
      { status: 'paused', target: { kind: 'session', sessionId: paused.id }, involvedSessionIds: [paused.id] },
      { status: 'ended', target: { kind: 'session', sessionId: ended.id }, involvedSessionIds: [ended.id] },
    ],
  })
  const summary = await runOnce(ctx, config)
  assert.equal(summary.moved, 1)
  assert.equal(await exists(paused.dir), true)
  assert.equal(await exists(ended.dir), false)
})

test('runOnce：guard 数据源失败 → 不移动，但回收站照常清理', async () => {
  const home = await makeHome()
  const config = configFor(home, { dryRun: false })
  const session = await addSession(config)
  const stale = await addTrashEntry(config, { ageDays: 9 })
  const ctx = { get: () => undefined, logger: undefined }

  const summary = await runOnce(ctx, config)
  assert.equal(summary.moved, 0)
  assert.equal(summary.errors, 1)
  assert.equal(summary.purged, 1)
  assert.equal(await exists(session.dir), true)
  assert.equal(await exists(stale.entryDir), false)
})

test('runOnce：会话列表失败 → 不移动，但回收站照常清理', async () => {
  const home = await makeHome()
  const config = configFor(home, { dryRun: false })
  const session = await addSession(config)
  const stale = await addTrashEntry(config, { ageDays: 9 })
  const ctx = {
    get: (name) => {
      if (name === 'sessionPersistence') return { list: async () => { throw new Error('list 挂了') } }
      if (name === 'workspaceRegistry') return { archivedSessionIds: [session.id], pinnedSessionIds: [] }
      if (name === 'sessions') return { list: () => [] }
      if (name === 'schedule') return { catalog: async () => [] }
      return undefined
    },
    logger: undefined,
  }

  const summary = await runOnce(ctx, config)
  assert.equal(summary.moved, 0)
  assert.equal(summary.errors, 1)
  assert.equal(summary.purged, 1)
  assert.equal(await exists(session.dir), true)
})

test('runOnce：schedule.catalog 失败时回退 schedule.json', async () => {
  const home = await makeHome()
  const config = configFor(home, { dryRun: false })
  const scheduled = await addSession(config)
  const plain = await addSession(config)
  await mkdir(path.dirname(config.scheduleStorePath), { recursive: true })
  await writeFile(
    config.scheduleStorePath,
    JSON.stringify({
      tables: {
        tasks: {
          'schedule-1': {
            status: 'active',
            target: { kind: 'session', sessionId: scheduled.id },
            involvedSessionIds: [scheduled.id],
          },
        },
      },
    }),
    'utf8',
  )
  const ctx = ctxStub({
    snapshots: [scheduled.snapshot, plain.snapshot],
    archived: [scheduled.id, plain.id],
    catalogThrows: true,
  })
  const summary = await runOnce(ctx, config)
  assert.equal(summary.moved, 1)
  assert.equal(await exists(scheduled.dir), true)
  assert.equal(await exists(plain.dir), false)
})

test('runOnce：锁被占 → 本轮跳过', async () => {
  const home = await makeHome()
  const config = configFor(home, { dryRun: false })
  const session = await addSession(config)
  const lock = await acquireLock(`${config.statePath}.lock`, config.lockStaleMs)
  const ctx = ctxStub({ snapshots: [session.snapshot], archived: [session.id] })
  const summary = await runOnce(ctx, config)
  assert.equal(summary.skipped, 'locked')
  assert.equal(await exists(session.dir), true)
  await lock.release()
})

test('acquireLock：stale 锁会被抢走，新锁会拒绝', async () => {
  const home = await makeHome()
  const config = configFor(home)
  const lockPath = `${config.statePath}.lock`
  await mkdir(path.dirname(lockPath), { recursive: true })
  await writeFile(lockPath, '{"pid":1}', 'utf8')
  const old = new Date(Date.now() - 20 * 60_000)
  await utimes(lockPath, old, old)

  const lock = await acquireLock(lockPath, 10 * 60_000)
  await assert.rejects(() => acquireLock(lockPath, 10 * 60_000), (error) => error instanceof LockBusyError)
  await lock.release()
  assert.equal(await exists(lockPath), false)
})

/* ------------------------------------------------------------------ */
/* 恢复                                                                */
/* ------------------------------------------------------------------ */

test('restoreEntry：按会话 id 找回文件与缓存，条目消失', async () => {
  const home = await makeHome()
  const config = configFor(home, { dryRun: false })
  const session = await addSession(config)
  const plan = await planMoves({ config, snapshots: [session.snapshot], archived: new Set([session.id]) })
  const moved = await moveOne(config, plan.candidates[0])
  assert.equal(moved.moved, true)

  const result = await restoreEntry(config, { sessionId: session.id })
  assert.equal(result.restored, true)
  assert.equal(result.sessionId, session.id)
  assert.equal(result.projectionCacheRestored, true)
  assert.equal(await exists(session.dir), true)
  assert.equal(await exists(path.join(session.dir, 'session.v4.jsonl.zstd')), true)
  assert.equal(await exists(session.cachePath), true)
  assert.equal(await exists(moved.entryDir), false, '条目应被清掉')
})

test('restoreEntry：目标已存在 → 拒绝覆盖', async () => {
  const home = await makeHome()
  const config = configFor(home, { dryRun: false })
  const session = await addSession(config)
  const plan = await planMoves({ config, snapshots: [session.snapshot], archived: new Set([session.id]) })
  await moveOne(config, plan.candidates[0])

  /* 用户在恢复前手工把目录放回去了 */
  await mkdir(session.dir, { recursive: true })
  await writeFile(path.join(session.dir, 'session.v4.jsonl.zstd'), 'user copy')

  await assert.rejects(() => restoreEntry(config, { sessionId: session.id }), /拒绝覆盖/)
  assert.equal(await readFile(path.join(session.dir, 'session.v4.jsonl.zstd'), 'utf8'), 'user copy')
})

test('restoreEntry：同一会话多个条目 → 必须用 --entry 指定', async () => {
  const home = await makeHome()
  const config = configFor(home, { dryRun: false })
  const id = newSessionId()
  const first = await addTrashEntry(config, { id, ageDays: 8 })
  const second = await addTrashEntry(config, { id, ageDays: 3 })
  await assert.rejects(() => restoreEntry(config, { sessionId: id }), /--entry/)

  const result = await restoreEntry(config, { entryName: second.entryName })
  assert.equal(result.restored, true)
  assert.equal(await exists(first.entryDir), true, '另一条不该被动')
})

test('restoreEntry：dry-run 只报告', async () => {
  const home = await makeHome()
  const config = configFor(home, { dryRun: false })
  const session = await addSession(config)
  const plan = await planMoves({ config, snapshots: [session.snapshot], archived: new Set([session.id]) })
  const moved = await moveOne(config, plan.candidates[0])

  const result = await restoreEntry(config, { sessionId: session.id, dryRun: true })
  assert.equal(result.dryRun, true)
  assert.equal(result.restored, false)
  assert.equal(await exists(session.dir), false)
  assert.equal(await exists(moved.entryDir), true)
})

/* ------------------------------------------------------------------ */
/* 插件入口                                                            */
/* ------------------------------------------------------------------ */

test('apply：enabled=false 时不调度', async () => {
  const home = await makeHome()
  const config = await import('../index.js')
  const result = await config.apply({ effect: () => {} }, {
    enabled: false,
    logFile: path.join(home, 'logs', 'purge.log'),
  })
  assert.equal(result, undefined)
})

test('apply：调度后 dispose 能清掉定时器', async () => {
  const home = await makeHome()
  const module = await import('../index.js')
  let disposer = null
  const ctx = {
    effect: (factory) => {
      disposer = factory()
    },
  }
  const cleanup = await module.apply(ctx, {
    sessionsRoot: path.join(home, 'sessions'),
    trashRoot: path.join(home, 'session-purge', 'trash'),
    statePath: path.join(home, 'session-purge', 'state.json'),
    logFile: path.join(home, 'logs', 'purge.log'),
    startupDelayMs: 60_000,
    intervalMinutes: 60,
  })
  assert.equal(typeof disposer, 'function')
  assert.equal(typeof cleanup, 'function')
  await cleanup()
})
