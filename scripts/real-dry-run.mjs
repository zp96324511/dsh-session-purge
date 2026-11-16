#!/usr/bin/env node
/**
 * 对真实 `~/.dsh` 做一次**只读**的「如果今天运行会怎样」报告。
 *
 * 这个脚本不启动 DSH 宿主，也不搬任何文件：它自己扫 `sessions/` 建出
 * `SessionPersistenceSnapshot` 形状，读 `workspace.json` / `schedule.json`，
 * 然后调用插件里同一个 `planMoves()`。因此它验证的是真实数据与真实判定逻辑，
 * 但不会写 state、不建回收站、不碰会话文件。
 *
 *   node scripts/real-dry-run.mjs
 *   node scripts/real-dry-run.mjs --json
 *   node scripts/real-dry-run.mjs --retention-days 0     # 只模拟，不移动
 *
 * 差别说明：真实宿主里 `ctx.sessions.list()` 能给出「进程内活会话」，这里没有宿主，
 * 所以 live 集合为空（pinned / 定时任务仍然按 workspace.json / schedule.json 计算）。
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { zstdDecompressSync } from 'node:zlib'
import {
  formatBytes,
  normalizeConfig,
  planMoves,
  readScheduledIdsFromFile,
} from '../index.js'

const ARTIFACT_RE = /^session\.v(\d+)\.jsonl(?:\.zstd)?$/
const SESSION_DIR_RE = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const DAY = 86_400_000
const MAX_HEADER_BYTES = 24 * 1024 * 1024

function isZstd(file) {
  return file.endsWith('.zstd')
}

/** 读取会话日志第一行（header 事件）；失败返回 null。 */
async function readHeader(artifact) {
  try {
    const info = await stat(artifact)
    if (info.size > MAX_HEADER_BYTES) return null
    const raw = await readFile(artifact)
    const text = isZstd(artifact) ? zstdDecompressSync(raw).toString('utf8') : raw.toString('utf8')
    const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'))
    const event = JSON.parse(firstLine)
    if (event?.type !== 'session') return null
    return {
      version: event.version,
      id: event.id,
      createdAt: event.createdAt,
      cwd: event.cwd,
      parentSession: event.parentSession,
      isSeeded: event.isSeeded,
      delegationDepth: event.delegationDepth,
    }
  } catch {
    return null
  }
}

/** 扫出全部会话快照（与 `sessionPersistence.list()` 等价的最小形状）。 */
async function collectSnapshots(config) {
  const snapshots = []
  const problems = []
  let workspaceDirs = []
  try {
    workspaceDirs = await readdir(config.sessionsRoot, { withFileTypes: true })
  } catch (error) {
    throw new Error(`读不了 sessionsRoot：${error.message}`)
  }
  for (const workspace of workspaceDirs) {
    if (!workspace.isDirectory() || workspace.isSymbolicLink()) continue
    const workspacePath = path.join(config.sessionsRoot, workspace.name)
    let sessionDirs = []
    try {
      sessionDirs = await readdir(workspacePath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory() || sessionDir.isSymbolicLink()) continue
      if (!SESSION_DIR_RE.test(sessionDir.name)) continue
      const dir = path.join(workspacePath, sessionDir.name)
      let files = []
      try {
        files = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      const artifactEntry = files.find((file) => file.isFile() && ARTIFACT_RE.test(file.name))
      if (artifactEntry === undefined) {
        problems.push({ sessionId: sessionDir.name, reason: 'no-artifact' })
        continue
      }
      const artifact = path.join(dir, artifactEntry.name)
      const header = await readHeader(artifact)
      snapshots.push({
        header: header ?? { version: 4, id: sessionDir.name },
        location: { kind: 'jsonl', path: artifact },
        revision: 'readonly',
      })
    }
  }
  return { snapshots, problems }
}

async function readWorkspaceStore(config) {
  const raw = await readFile(config.workspaceStorePath, 'utf8')
  const data = JSON.parse(raw)
  const archived = Array.isArray(data?.global?.archivedSessionIds) ? data.global.archivedSessionIds : []
  const pinned = Array.isArray(data?.global?.pinnedSessionIds) ? data.global.pinnedSessionIds : []
  return { archived, pinned, bytes: Buffer.byteLength(raw) }
}

/** 回收站现状（不存在就是空）。 */
async function inspectTrash(config) {
  let entries = []
  try {
    entries = await readdir(config.trashRoot, { withFileTypes: true })
  } catch {
    return { exists: false, count: 0, bytes: 0, oldestDays: null, newestDays: null }
  }
  let bytes = 0
  let oldest = null
  let newest = null
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const dir = path.join(config.trashRoot, entry.name)
    try {
      const info = await stat(dir)
      const age = (Date.now() - info.mtimeMs) / DAY
      oldest = oldest === null ? age : Math.max(oldest, age)
      newest = newest === null ? age : Math.min(newest, age)
    } catch {
      /* 读不了就跳过 */
    }
  }
  return { exists: true, count: entries.filter((entry) => entry.isDirectory()).length, bytes, oldestDays: oldest, newestDays: newest }
}

async function fingerprint(config) {
  let sessionsCount = 0
  try {
    const workspaces = await readdir(config.sessionsRoot, { withFileTypes: true })
    for (const workspace of workspaces) {
      if (!workspace.isDirectory()) continue
      const dirs = await readdir(path.join(config.sessionsRoot, workspace.name), { withFileTypes: true })
      sessionsCount += dirs.filter((entry) => entry.isDirectory() && SESSION_DIR_RE.test(entry.name)).length
    }
  } catch {
    sessionsCount = -1
  }
  let workspaceStat = null
  try {
    workspaceStat = await stat(config.workspaceStorePath)
  } catch {
    workspaceStat = null
  }
  return {
    sessionsCount,
    workspaceStoreSize: workspaceStat?.size ?? null,
    workspaceStoreMtimeMs: workspaceStat?.mtimeMs ?? null,
  }
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: false,
    options: {
      home: { type: 'string' },
      'retention-days': { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  if (values.help === true) {
    process.stdout.write(
      'node scripts/real-dry-run.mjs [--home <dsh home>] [--retention-days N] [--json]\n\n只读：只打印「如果运行会移动/清理什么」，不写任何文件。\n',
    )
    return 0
  }

  const overrides = {}
  if (typeof values['retention-days'] === 'string') overrides.archiveRetentionDays = Number(values['retention-days'])
  const config = normalizeConfig(overrides, values.home)

  const before = await fingerprint(config)
  const { snapshots, problems } = await collectSnapshots(config)
  const workspace = await readWorkspaceStore(config)
  const scheduled = await readScheduledIdsFromFile(config.scheduleStorePath)
  const pinned = new Set(workspace.pinned)
  const protectedIds = new Set([...pinned, ...scheduled])
  const archived = new Set(workspace.archived)

  const plan = await planMoves({
    config,
    snapshots,
    archived,
    protectedIds,
  })
  const after = await fingerprint(config)
  const trash = await inspectTrash(config)

  /* 归档 id 里有 live 文件的、以及没有文件的，分开统计。 */
  const liveArchived = []
  const missingArchived = []
  for (const id of archived) {
    const snapshot = snapshots.find((item) => item?.header?.id === id)
    if (snapshot?.location?.path !== undefined) liveArchived.push({ id, artifact: snapshot.location.path })
    else missingArchived.push(id)
  }
  const ages = []
  for (const item of liveArchived) {
    try {
      const info = await stat(item.artifact)
      ages.push({ id: item.id, ageDays: (Date.now() - info.mtimeMs) / DAY, sizeBytes: info.size })
    } catch {
      /* 文件刚消失 */
    }
  }
  ages.sort((a, b) => b.ageDays - a.ageDays)
  const maxAgeDays = ages.length === 0 ? null : Number(ages[0].ageDays.toFixed(1))
  const totalBytes = ages.reduce((sum, item) => sum + item.sizeBytes, 0)

  const report = {
    dryRun: true,
    dshHome: config.home,
    sessionsRoot: config.sessionsRoot,
    trashRoot: config.trashRoot,
    archiveRetentionDays: config.archiveRetentionDays,
    trashRetentionDays: config.trashRetentionDays,
    scanned: plan.scanned,
    archivedIds: archived.size,
    archivedWithFiles: liveArchived.length,
    archivedWithoutFiles: missingArchived.length,
    archivedBytes: totalBytes,
    pinned: pinned.size,
    scheduledProtected: scheduled.size,
    eligible: plan.eligible,
    wouldMove: plan.candidates.length,
    reasons: plan.reasons,
    oldestArchivedDays: maxAgeDays,
    trash,
    unchanged: {
      sessionsBefore: before.sessionsCount,
      sessionsAfter: after.sessionsCount,
      workspaceStoreUnchanged:
        before.workspaceStoreSize === after.workspaceStoreSize && before.workspaceStoreMtimeMs === after.workspaceStoreMtimeMs,
    },
    problems,
  }

  if (values.json === true) {
    process.stdout.write(`${JSON.stringify({ report, candidates: plan.candidates.map((c) => ({ sessionId: c.sessionId, ageDays: Number((c.ageMs / DAY).toFixed(1)) })), oldest: ages.slice(0, 10) }, null, 2)}\n`)
  } else {
    const lines = []
    lines.push('dsh-session-purge 只读预演（不写任何文件）')
    lines.push(`  DSH home          ${config.home}`)
    lines.push(`  sessionsRoot      ${config.sessionsRoot}`)
    lines.push(`  trashRoot         ${config.trashRoot}`)
    lines.push(`  保留期            归档 ${config.archiveRetentionDays} 天 → 回收站；回收站 ${config.trashRetentionDays} 天 → 删除`)
    lines.push('')
    lines.push(`  扫描到会话        ${report.scanned}`)
    lines.push(`  归档 id           ${report.archivedIds}（有 live 文件 ${report.archivedWithFiles} 个 / ${formatBytes(report.archivedBytes)}，无 live 文件 ${report.archivedWithoutFiles} 个）`)
    lines.push(`  置顶 / 定时保护   ${report.pinned} / ${report.scheduledProtected}`)
    lines.push(`  满足移动条件      ${report.eligible}（本轮会移动 ${report.wouldMove}）`)
    if (maxAgeDays !== null) lines.push(`  归档文件最大年龄  ${maxAgeDays} 天`)
    const reasonText = Object.entries(report.reasons)
      .map(([reason, count]) => `${reason}=${count}`)
      .join(' ')
    if (reasonText !== '') lines.push(`  跳过原因          ${reasonText}`)
    lines.push('')
    lines.push(
      `  回收站            ${trash.count === 0 ? '空（不存在或没有条目）' : `${trash.count} 个条目，最老 ${trash.oldestDays?.toFixed(1)} 天`}`,
    )
    lines.push('')
    if (ages.length > 0) {
      lines.push('  最老的 10 个归档会话：')
      for (const item of ages.slice(0, 10)) {
        lines.push(`    ${item.ageDays.toFixed(1).padStart(5)} 天  ${formatBytes(item.sizeBytes).padStart(9)}  ${item.id}`)
      }
      lines.push('')
    }
    if (plan.candidates.length > 0) {
      lines.push('  本轮会移动：')
      for (const candidate of plan.candidates) {
        lines.push(`    ${candidate.sessionId}  ${(candidate.ageMs / DAY).toFixed(1)} 天  ${formatBytes(candidate.sizeBytes)}`)
      }
      lines.push('')
    }
    lines.push(
      `  只读校验          sessions ${before.sessionsCount} → ${after.sessionsCount}；workspace.json ${report.unchanged.workspaceStoreUnchanged ? '未变' : '被改动了（异常！）'}`,
    )
    process.stdout.write(`${lines.join('\n')}\n`)
  }

  if (after.sessionsCount !== before.sessionsCount) {
    process.stderr.write('sessions 目录数量发生变化，预演不是只读的——请检查！\n')
    return 1
  }
  if (values.json !== true && plan.candidates.length === 0) {
    process.stdout.write('\n结论：今天没有会话满足移动条件（这是正常的，不是失败）。\n')
  }
  return 0
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    process.stderr.write(`${error?.stack ?? String(error)}\n`)
    process.exitCode = 1
  })
