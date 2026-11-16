/**
 * dsh-session-purge — 归档会话的分段回收（DSH 宿主插件）。
 *
 * 一次「每日」运行分两段，保留期各不相同：
 *
 *   1. 归档移动：会话在 `workspaceRegistry.archivedSessionIds` 里、会话文件
 *      `session.v4.jsonl.zstd` 的 mtime 超过 `archiveRetentionDays`（默认 30 天）
 *      → 把整个 `session-<uuid>` 目录 + 投影缓存 **移动** 到 trashRoot；
 *   2. 回收站清理：条目从 `movedAt` 起满 `trashRetentionDays`（默认 7 天）
 *      → 物理删除。
 *
 * 关键设计（详见 HANDOFF.md）：
 *
 * - 判定口径是「会话文件 mtime」，不是「归档时间」——DSH 没有 archivedAt；
 * - 默认 `dryRun: true`：第一次只看报告，不动任何文件；
 * - 从不 `rm` 归档会话：所有删除都必须先经过回收站；
 * - 不改 `workspace.json`：归档 id 只是字符串，重启后 DSH 按缺失 header 过滤；
 * - 家族保守：父子会话（subagent）任一方不满足条件，整族本轮都不动；
 * - 零外部依赖：只用 `node:` 内建模块；配置由 `cordis.patch.yml` 作为对象传入
 *   （不导出 schemastery 的 `Config`，profile 的 node_modules 根没有那个包）。
 */

import { appendFile, cp, lstat, mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Cordis 插件名（Loader 诊断与 patch 的 `name` 都对它）。 */
export const name = 'dsh-session-purge'

/** 写进每条 trash 的 `meta.json`，测试会核对它与 package.json 一致。 */
export const version = '0.1.0'

const DAY_MS = 86_400_000
const STATE_VERSION = 1
const META_VERSION = 1

/** DSH 的会话 id 格式；任何不匹配的一律不碰。 */
const SESSION_ID_RE = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** 会话日志文件名：`session.v4.jsonl.zstd`（也可能是未压缩的 `.jsonl`，或更高的 v 号）。 */
const ARTIFACT_RE = /^session\.v\d+\.jsonl(?:\.zstd)?$/

/** 回收站条目名：`YYYYMMDDTHHMMSSmmmZ__<sessionId>`，字典序即时间序。 */
const ENTRY_NAME_RE = /^\d{8}T\d{6}\d{3}Z__session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

/** 会话 id 是否合法（纯函数）。 */
export function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID_RE.test(value)
}

/** 人类可读的字节数，用于日志。 */
export function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${unit === 0 || size >= 100 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`
}

/** 天数，一位小数。 */
function days(ms) {
  return Number.isFinite(ms) ? (ms / DAY_MS).toFixed(1) : '?'
}

/** 错误一行化（保留 `code`，Windows 的 EPERM/EBUSY 很有用）。 */
function describeError(error) {
  const code = typeof error?.code === 'string' ? `${error.code}: ` : ''
  const message = error?.message ?? String(error)
  return `${code}${message}`
}

/** UTC 紧凑时间：`20261113T014500123Z`。 */
export function utcCompact(ms) {
  const date = new Date(ms)
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return [
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`,
    'T',
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}${pad(date.getUTCMilliseconds(), 3)}`,
    'Z',
  ].join('')
}

/** 条目名（纯函数）：时间戳进名字，清理时不必读 meta 就能排序，也不会同名冲突。 */
export function entryNameFor(ms, sessionId) {
  if (!isSessionId(sessionId)) throw new Error(`invalid session id: ${sessionId}`)
  return `${utcCompact(ms)}__${sessionId}`
}

/** 取服务：优先属性访问（Cordis 代理），其次 `ctx.get()`；活 fiber 之外不抛。 */
function getService(ctx, serviceName) {
  if (ctx === null || ctx === undefined) return undefined
  try {
    const direct = ctx[serviceName]
    if (direct !== undefined && direct !== null) return direct
  } catch {
    /* Cordis 代理在 fiber 失活时可能抛错，交给 get() */
  }
  try {
    if (typeof ctx.get === 'function') return ctx.get(serviceName)
  } catch {
    /* 服务不存在就是不存在 */
  }
  return undefined
}

/** `root` 与 `target` 是否是同一个路径（Windows 大小写不敏感）。 */
function samePath(a, b) {
  const left = path.resolve(a)
  const right = path.resolve(b)
  if (process.platform === 'win32') return left.toLowerCase() === right.toLowerCase()
  return left === right
}

/**
 * `target` 是否严格位于 `root` 之下（不含相等）。
 * `path.win32.relative` 内部按小写比较，盘符/用户名大小写差异不会误判。
 */
export function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  if (relative === '') return false
  if (path.isAbsolute(relative)) return false
  return relative !== '..' && !relative.startsWith(`..${path.sep}`)
}

/** 相对 `root` 的路径段；逃逸出 root 时返回 null。 */
export function segmentsUnder(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  if (relative === '') return []
  if (path.isAbsolute(relative)) return null
  if (relative === '..' || relative.startsWith(`..${path.sep}`)) return null
  return relative.split(path.sep).filter((part) => part !== '')
}

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

/** DSH home：`$DSH_HOME` 优先，否则 `~/.dsh`（与启动器、fast-search 同口径）。 */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv.trim())
  return path.join(os.homedir(), '.dsh')
}

function numberOption(value, fallback, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  const clamped = Math.min(max, Math.max(min, parsed))
  return integer ? Math.trunc(clamped) : clamped
}

function pathOption(value, fallback) {
  if (typeof value === 'string' && value.trim() !== '') return path.resolve(value.trim())
  return path.resolve(fallback)
}

/**
 * 把 patch 里传入的原始对象规整成运行配置。
 *
 * 所有路径都可以不配：缺省值按 `resolveDshHome()` 推导，临时 `DSH_HOME` 的
 * 端到端测试因此不需要写一套绝对路径。
 *
 * @param {Record<string, unknown>} [config] `cordis.patch.yml` 的 `config`。
 * @param {string} [home] DSH home（测试直接传临时目录）。
 * @returns {Record<string, any>} 规整后的配置。
 */
export function normalizeConfig(config = {}, home = resolveDshHome()) {
  const root = path.resolve(home)
  const source = config && typeof config === 'object' ? config : {}
  return {
    home: root,
    enabled: source.enabled !== false,
    /* 默认 dry-run：第一次运行只出报告。 */
    dryRun: source.dryRun !== false,
    archiveRetentionDays: numberOption(source.archiveRetentionDays, 30, { min: 0, max: 36_500 }),
    trashRetentionDays: numberOption(source.trashRetentionDays, 7, { min: 0, max: 36_500 }),
    intervalMinutes: numberOption(source.intervalMinutes, 1440, { min: 1, max: 10_080 }),
    startupDelayMs: numberOption(source.startupDelayMs, 60_000, { min: 0, max: DAY_MS }),
    maxMovesPerRun: numberOption(source.maxMovesPerRun, 50, { min: 0, max: 10_000, integer: true }),
    maxTrashPurgesPerRun: numberOption(source.maxTrashPurgesPerRun, 100, { min: 0, max: 10_000, integer: true }),
    moveProjectionCache: source.moveProjectionCache !== false,
    lockStaleMs: numberOption(source.lockStaleMs, 600_000, { min: 1_000, max: 86_400_000 }),
    sessionsRoot: pathOption(source.sessionsRoot, path.join(root, 'sessions')),
    projectionCacheDir: pathOption(source.projectionCacheDir, path.join(root, 'storages', 'session_projcache', 'sessions')),
    workspaceStorePath: pathOption(source.workspaceStorePath, path.join(root, 'storages', 'workspace.json')),
    scheduleStorePath: pathOption(source.scheduleStorePath, path.join(root, 'storages', 'schedule.json')),
    trashRoot: pathOption(source.trashRoot, path.join(root, 'session-purge', 'trash')),
    statePath: pathOption(source.statePath, path.join(root, 'session-purge', 'state.json')),
    logFile: pathOption(source.logFile, path.join(root, 'logs', 'session-purge.log')),
  }
}

/**
 * 会伤到数据的配置组合。返回空数组才算可用。
 * @param {Record<string, any>} config 规整后的配置。
 * @returns {string[]} 问题描述。
 */
export function validateConfig(config) {
  const problems = []
  if (samePath(config.trashRoot, config.sessionsRoot)) {
    problems.push('trashRoot 不能等于 sessionsRoot')
  } else if (isInside(config.sessionsRoot, config.trashRoot)) {
    problems.push('trashRoot 不能放在 sessionsRoot 里面——DSH 会把回收站当成会话目录扫描')
  }
  if (isInside(config.trashRoot, config.sessionsRoot)) {
    problems.push('sessionsRoot 不能放在 trashRoot 里面')
  }
  if (samePath(config.statePath, config.sessionsRoot)) {
    problems.push('statePath 不能是 sessionsRoot 本身')
  }
  return problems
}

/** 锁文件路径：`state.json.lock`（restore.mjs 用同一把锁）。 */
export function lockPathFor(config) {
  return `${config.statePath}.lock`
}

/** 投影缓存文件路径。 */
export function projectionCachePath(config, sessionId) {
  return path.join(config.projectionCacheDir, `${sessionId}.json`)
}

/* ------------------------------------------------------------------ */
/* fs 小助手                                                           */
/* ------------------------------------------------------------------ */

/** `readdir`，目录不存在当作空。 */
export async function readdirSafe(dir, options) {
  try {
    return await readdir(dir, options)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

/** `stat`，不存在返回 null。 */
async function statSafe(target) {
  try {
    return await stat(target)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

/** `lstat`，不存在返回 null（不跟随符号链接）。 */
async function lstatSafe(target) {
  try {
    return await lstat(target)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

/** 读 JSON；不存在返回 null，坏 JSON 抛错。 */
export async function readJson(file) {
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`${file} 不是合法 JSON：${error.message}`)
  }
}

/** 原子写 JSON：先写同目录 tmp，再 rename。 */
export async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    await rename(tmp, file)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

/** 递归求和目录里普通文件的大小（不跟随符号链接）。 */
async function dirSize(root) {
  let total = 0
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      try {
        const info = await stat(full)
        if (info.isFile()) total += info.size
      } catch {
        /* 统计失败不影响删除 */
      }
    }
  }
  return total
}

/**
 * 移动路径：同卷 `rename` 原子完成；`EXDEV` 回退 `cp --recursive` + `rm`。
 * 回退是「全有或全无」：rm 失败会把刚拷的副本删掉，绝不留下两份。
 * @returns {Promise<'rename'|'copy'>} 实际使用的方式。
 */
export async function movePath(from, to) {
  try {
    await rename(from, to)
    return 'rename'
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
    await cp(from, to, { recursive: true, preserveTimestamps: true, force: false, errorOnExist: true })
    try {
      await rm(from, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch (removeError) {
      await rm(to, { recursive: true, force: true }).catch(() => {})
      throw removeError
    }
    return 'copy'
  }
}

/* ------------------------------------------------------------------ */
/* 单飞锁                                                              */
/* ------------------------------------------------------------------ */

/** 锁被别人持有（或抢 stale 失败）。调用方把它当成「本轮跳过」。 */
export class LockBusyError extends Error {
  constructor(message, detail = null) {
    super(message)
    this.name = 'LockBusyError'
    this.detail = detail
  }
}

/**
 * 抢锁：`open(..., 'wx')` 是原子创建。已存在且超过 `staleMs` 才视为残留并抢走。
 *
 * @param {string} lockPath 锁文件。
 * @param {number} staleMs 超过多久算残留。
 * @param {{ now?: number }} [options] 测试注入时间。
 * @returns {Promise<{ path: string, token: string, release: () => Promise<void> }>}
 */
export async function acquireLock(lockPath, staleMs = 600_000, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  await mkdir(path.dirname(lockPath), { recursive: true })
  const token = JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() })

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx')
      try {
        await handle.writeFile(token, 'utf8')
      } finally {
        await handle.close()
      }
      return {
        path: lockPath,
        token,
        async release() {
          try {
            /* 只删自己的锁：万一被当成 stale 抢走，别删别人的。 */
            const current = await readFile(lockPath, 'utf8')
            if (current === token) await unlink(lockPath)
          } catch {
            /* 锁已经不在就算释放成功 */
          }
        },
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const info = await statSafe(lockPath)
      const ageMs = info === null ? Number.POSITIVE_INFINITY : now - info.mtimeMs
      if (attempt === 0 && ageMs >= staleMs) {
        let content = ''
        try {
          content = (await readFile(lockPath, 'utf8')).trim()
        } catch {
          /* 读不到内容也照样抢 */
        }
        await unlink(lockPath).catch(() => {})
        if (content !== '') {
          /* 只记录，不改行为：残留锁的内容对排查有用 */
        }
        continue
      }
      throw new LockBusyError(`锁被占用：${lockPath}`, `ageMs=${Number.isFinite(ageMs) ? Math.round(ageMs) : 'unknown'}`)
    }
  }
  throw new LockBusyError(`抢锁失败：${lockPath}`)
}

/**
 * 持锁执行。
 * @template T
 * @param {string} lockPath 锁文件。
 * @param {number} staleMs 残留阈值。
 * @param {() => Promise<T>} fn 临界区。
 * @returns {Promise<T>}
 */
export async function withLock(lockPath, staleMs, fn) {
  const lock = await acquireLock(lockPath, staleMs)
  try {
    return await fn()
  } finally {
    await lock.release()
  }
}

/* ------------------------------------------------------------------ */
/* 日志                                                                */
/* ------------------------------------------------------------------ */

/*
 * 日志落盘是排队异步写：调用方不用 await，`flush()` 等队列排空。
 * `debug` 只进文件；info/warn/error 同时镜像到宿主 logger（没有就算了）。
 */
export function createLogger(ctx, file) {
  let chain = Promise.resolve()
  const mirror = (level, message) => {
    try {
      const logger = ctx?.logger
      if (logger === null || logger === undefined) return
      const sink = typeof logger === 'function' ? logger : logger[level]
      if (typeof sink === 'function') sink.call(logger, `[session-purge] ${message}`)
    } catch {
      /* 日志失败不影响回收 */
    }
  }
  const write = (level, message, mirrorIt) => {
    const line = `[${new Date().toISOString()}] [${level}] ${message}`
    chain = chain.then(async () => {
      try {
        await mkdir(path.dirname(file), { recursive: true })
        await appendFile(file, `${line}\n`, 'utf8')
      } catch {
        /* 写不了日志也继续：状态与 meta 才是正确性来源 */
      }
    })
    if (mirrorIt) mirror(level, message)
  }
  return {
    file,
    debug: (message) => write('debug', message, false),
    info: (message) => write('info', message, true),
    warn: (message) => write('warn', message, true),
    error: (message) => write('error', message, true),
    flush: () => chain,
  }
}

/* ------------------------------------------------------------------ */
/* 路径校验                                                            */
/* ------------------------------------------------------------------ */

function bad(reason, detail) {
  return { ok: false, reason, detail: detail ?? null }
}

/**
 * 从 `SessionPersistenceSnapshot` 解析并校验会话目录（第 5.6 节的安全闸）。
 *
 * 全部满足才算 ok：
 * - id 匹配 `session-<uuid>`；
 * - `location.kind === 'jsonl'`；
 * - 文件名是 `session.vN.jsonl[.zstd]`；
 * - 目录名就是会话 id，父目录是 sessionsRoot 的直接子目录；
 * - 相对 sessionsRoot 恰好 3 段（workspaceDir / sessionId / artifact）；
 * - workspace 目录、会话目录、会话文件都不是符号链接/junction。
 *
 * @param {Record<string, any>} config 规整配置。
 * @param {{ header?: { id?: string }, location?: { kind?: string, path?: string } }} snapshot 持久化快照。
 * @returns {Promise<{ok: true, sessionId: string, artifact: string, sessionDir: string, workspaceDir: string, workspaceDirName: string, sizeBytes: number, mtimeMs: number} | {ok: false, reason: string, detail: string|null}>}
 */
export async function resolveSessionDir(config, snapshot) {
  const sessionId = snapshot?.header?.id
  if (!isSessionId(sessionId)) return bad('bad-session-id', String(sessionId))
  const location = snapshot?.location
  if (location === null || location === undefined || location.kind !== 'jsonl') return bad('no-jsonl-location')
  if (typeof location.path !== 'string' || location.path === '') return bad('no-artifact-path')

  const artifact = path.resolve(location.path)
  const artifactName = path.basename(artifact)
  if (!ARTIFACT_RE.test(artifactName)) return bad('bad-artifact-name', artifactName)

  const sessionDir = path.dirname(artifact)
  if (path.basename(sessionDir) !== sessionId) return bad('dir-name-mismatch', path.basename(sessionDir))

  const workspaceDir = path.dirname(sessionDir)
  const parts = segmentsUnder(config.sessionsRoot, artifact)
  if (parts === null) return bad('outside-sessions-root', artifact)
  if (parts.length !== 3) return bad('unexpected-depth', parts.join('/'))

  /* 大小写不敏感的文件系统上逐段核对，避免 `..`/相似目录名绕过。 */
  const fold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value)
  if (fold(parts[0]) !== fold(path.basename(workspaceDir))) return bad('workspace-dir-mismatch', parts[0])
  if (fold(parts[1]) !== fold(sessionId)) return bad('session-dir-mismatch', parts[1])
  if (fold(parts[2]) !== fold(artifactName)) return bad('artifact-mismatch', parts[2])

  const workspaceStat = await lstatSafe(workspaceDir)
  if (workspaceStat === null || !workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) {
    return bad('workspace-dir-unusable', workspaceDir)
  }
  const dirStat = await lstatSafe(sessionDir)
  if (dirStat === null || !dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    return bad('session-dir-unusable', sessionDir)
  }
  const fileStat = await lstatSafe(artifact)
  if (fileStat === null || !fileStat.isFile() || fileStat.isSymbolicLink()) {
    return bad('artifact-unusable', artifact)
  }

  return {
    ok: true,
    sessionId,
    artifact,
    sessionDir,
    workspaceDir,
    workspaceDirName: path.basename(workspaceDir),
    artifactName,
    sizeBytes: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
  }
}

/* ------------------------------------------------------------------ */
/* 计划（纯读，可测试）                                                */
/* ------------------------------------------------------------------ */

/**
 * 计算本轮要移动哪些会话。
 *
 * 只 `lstat`/`stat`，不写任何文件，因此 dry-run 与单元测试都直接调它。
 *
 * 返回的 `candidates` 已按「先子后父、同层旧文件优先」排好序，并已应用
 * `maxMovesPerRun` 与截断后的家族复核（家族不会被切一半）。
 *
 * @param {{
 *   config: Record<string, any>,
 *   now?: number,
 *   snapshots: Array<Record<string, any>>,
 *   archived: Set<string> | Iterable<string>,
 *   protectedIds?: Set<string> | Iterable<string>,
 *   limit?: number,
 * }} input
 * @returns {Promise<{
 *   scanned: number, archivedCount: number, eligible: number,
 *   candidates: Array<Record<string, any>>,
 *   skipped: Array<{ sessionId: string|null, reason: string, ageDays?: number, detail?: string|null }>,
 *   reasons: Record<string, number>,
 * }>}
 */
export async function planMoves(input) {
  const config = input.config
  const now = Number.isFinite(input.now) ? input.now : Date.now()
  const snapshots = Array.isArray(input.snapshots) ? input.snapshots : []
  const archived = new Set(input.archived ?? [])
  const protectedIds = new Set(input.protectedIds ?? [])
  const limit = Number.isFinite(input.limit) ? Math.max(0, Math.trunc(input.limit)) : config.maxMovesPerRun
  const retentionMs = config.archiveRetentionDays * DAY_MS

  const byId = new Map()
  for (const snapshot of snapshots) {
    const id = snapshot?.header?.id
    if (typeof id === 'string' && id !== '') byId.set(id, snapshot)
  }

  /* 父子关系只连「本轮看得见的快照」：父会话若早已不在磁盘上（比如上一轮
     已移入回收站），子会话不该被它拖住。 */
  const parentOf = new Map()
  const childrenOf = new Map()
  for (const [id, snapshot] of byId) {
    const parent = snapshot?.header?.parentSession
    if (typeof parent !== 'string' || parent === '' || !byId.has(parent)) continue
    parentOf.set(id, parent)
    if (!childrenOf.has(parent)) childrenOf.set(parent, new Set())
    childrenOf.get(parent).add(id)
  }

  const adjacency = new Map()
  const link = (a, b) => {
    if (!adjacency.has(a)) adjacency.set(a, new Set())
    adjacency.get(a).add(b)
  }
  for (const [child, parent] of parentOf) {
    link(child, parent)
    link(parent, child)
  }

  const skipped = []
  const reasons = {}
  const note = (reason) => {
    reasons[reason] = (reasons[reason] ?? 0) + 1
  }
  const skip = (sessionId, reason, extra = {}) => {
    note(reason)
    skipped.push({ sessionId, reason, ...extra })
  }

  /* ---- 第一轮：归档集合内逐个验条件 ---- */
  const candidates = []
  const eligible = new Set()
  for (const id of archived) {
    const snapshot = byId.get(id)
    if (snapshot === undefined) {
      skip(id, 'no-snapshot')
      continue
    }
    if (protectedIds.has(id)) {
      skip(id, 'protected')
      continue
    }
    const resolved = await resolveSessionDir(config, snapshot)
    if (!resolved.ok) {
      skip(id, resolved.reason, { detail: resolved.detail })
      continue
    }
    const ageMs = now - resolved.mtimeMs
    /* 时钟回拨或未来 mtime：ageMs 为负，不移动。 */
    if (!(ageMs >= retentionMs)) {
      skip(id, 'not-eligible', { ageDays: Number(days(ageMs)) })
      continue
    }
    candidates.push({ ...resolved, ageMs, projectionCachePath: projectionCachePath(config, id) })
    eligible.add(id)
  }

  /* ---- 家族过滤：任一族员不满足条件，整族本轮不动 ---- */
  const componentVerdict = new Map()
  const componentMembers = (start) => {
    const seen = new Set([start])
    const queue = [start]
    while (queue.length > 0) {
      const current = queue.shift()
      for (const neighbor of adjacency.get(current) ?? []) {
        if (seen.has(neighbor)) continue
        seen.add(neighbor)
        queue.push(neighbor)
      }
    }
    return seen
  }
  const familyAllEligible = (id) => {
    if (componentVerdict.has(id)) return componentVerdict.get(id)
    const members = componentMembers(id)
    const ok = [...members].every((member) => eligible.has(member))
    for (const member of members) componentVerdict.set(member, ok)
    return ok
  }

  const movable = []
  for (const candidate of candidates) {
    if (!familyAllEligible(candidate.sessionId)) {
      skip(candidate.sessionId, 'family-mixed', { ageDays: Number(days(candidate.ageMs)) })
      continue
    }
    movable.push(candidate)
  }

  /* ---- 排序：depth 降序（子先父后），同层旧文件先走 ---- */
  const depthOf = (id) => {
    let depth = 0
    let cursor = id
    let guard = 0
    while (parentOf.has(cursor) && guard < 10_000) {
      cursor = parentOf.get(cursor)
      depth += 1
      guard += 1
    }
    return depth
  }
  for (const candidate of movable) {
    candidate.depth = depthOf(candidate.sessionId)
    candidate.childIds = [...(childrenOf.get(candidate.sessionId) ?? [])]
  }
  movable.sort((a, b) => b.depth - a.depth || a.mtimeMs - b.mtimeMs || a.sessionId.localeCompare(b.sessionId))

  /* ---- maxMovesPerRun 截断，再复核家族完整性 ---- */
  let selected = movable
  if (limit >= 0 && movable.length > limit) {
    const slice = movable.slice(0, limit)
    const selectedIds = new Set(slice.map((candidate) => candidate.sessionId))
    selected = []
    for (const candidate of slice) {
      const members = componentMembers(candidate.sessionId)
      if ([...members].every((member) => selectedIds.has(member))) {
        selected.push(candidate)
      } else {
        skip(candidate.sessionId, 'family-truncated', { ageDays: Number(days(candidate.ageMs)) })
      }
    }
    if (selected.length < slice.length) {
      /* 截断把家族拆开了：本轮只走完整的那些，剩下的下一轮整族再试。 */
    }
  }

  return {
    scanned: snapshots.length,
    archivedCount: archived.size,
    eligible: movable.length,
    candidates: selected,
    skipped,
    reasons,
  }
}

/* ------------------------------------------------------------------ */
/* 回收站                                                              */
/* ------------------------------------------------------------------ */

/** 校验条目名并返回条目目录；名字不合规直接抛（绝不删未知目录）。 */
export function trashEntryDir(config, entryName) {
  if (typeof entryName !== 'string' || !ENTRY_NAME_RE.test(entryName)) {
    throw new Error(`不安全的回收站条目名：${entryName}`)
  }
  const entryDir = path.join(config.trashRoot, entryName)
  if (!samePath(path.dirname(entryDir), config.trashRoot)) {
    throw new Error(`条目路径逃逸出 trashRoot：${entryDir}`)
  }
  return entryDir
}

/** 一条 meta（移动时写两次：moving → complete）。 */
function buildMeta(config, candidate, { now, state, projectionCacheMoved, projectionCacheExisted }) {
  const purgeAfter = now + config.trashRetentionDays * DAY_MS
  return {
    version: META_VERSION,
    state,
    sessionId: candidate.sessionId,
    workspaceDir: candidate.workspaceDirName,
    originalSessionDir: candidate.sessionDir,
    originalArtifact: candidate.artifact,
    /* 缓存不存在时记 null（schema 约定）；存在但没搬走（占用）时保留原路径，便于排查。 */
    originalProjectionCache: projectionCacheExisted === true ? (candidate.projectionCachePath ?? null) : null,
    artifactMtime: new Date(candidate.mtimeMs).toISOString(),
    sizeBytes: candidate.sizeBytes,
    movedAt: new Date(now).toISOString(),
    purgeAfter: new Date(purgeAfter).toISOString(),
    reason: 'archived-and-idle',
    projectionCacheMoved,
    pluginVersion: version,
  }
}

/**
 * 把一个会话搬进回收站。
 *
 * 顺序与回滚规则（第 4.3 节）：
 * 1. 二次校验（路径 + mtime），防止排队期间会话被重新打开写入；
 * 2. 建条目目录、写 `meta.json`（`state: "moving"`）；
 * 3. `rename` 整个会话目录 → `entry/session`；失败则删掉空条目，原会话不动；
 * 4. 投影缓存尽量搬走；占用（EBUSY/EPERM）就留在原地并记 `projectionCacheMoved:false`；
 * 5. 重写 meta 为 `state: "complete"`。
 *
 * 上下文缓存移动失败**不回滚**：回滚会和 DSH 打开/写缓存竞争；原缓存重启后可重建。
 *
 * @param {Record<string, any>} config 规整配置。
 * @param {Record<string, any>} candidate `planMoves` 的候选。
 * @param {{ now?: number, log?: ReturnType<typeof createLogger> }} [options]
 * @returns {Promise<{moved: boolean, reason?: string, error?: string, entryName?: string, entryDir?: string, bytes?: number, projectionCacheMoved?: boolean}>}
 */
export async function moveOne(config, candidate, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const log = options.log ?? { debug() {}, info() {}, warn() {}, error() {} }
  const retentionMs = config.archiveRetentionDays * DAY_MS

  /* ---- 二次校验 ---- */
  const artifactStat = await statSafe(candidate.artifact)
  if (artifactStat === null || !artifactStat.isFile()) return { moved: false, reason: 'artifact-missing' }
  const ageMs = now - artifactStat.mtimeMs
  if (!(ageMs >= retentionMs)) return { moved: false, reason: 'not-eligible' }

  const rechecked = await resolveSessionDir(config, {
    header: { id: candidate.sessionId },
    location: { kind: 'jsonl', path: candidate.artifact },
  })
  if (!rechecked.ok) return { moved: false, reason: rechecked.reason, error: rechecked.detail ?? undefined }

  const entryName = entryNameFor(now, candidate.sessionId)
  const entryDir = trashEntryDir(config, entryName)
  const current = {
    ...candidate,
    sessionDir: rechecked.sessionDir,
    artifact: rechecked.artifact,
    workspaceDirName: rechecked.workspaceDirName,
    mtimeMs: artifactStat.mtimeMs,
    sizeBytes: artifactStat.size,
    projectionCachePath: projectionCachePath(config, candidate.sessionId),
  }

  /* 先确认缓存是否存在：不存在的缓存 meta 记 null（schema 约定），
     存在但搬不走（EBUSY）才保留原路径。 */
  const cacheBefore = await statSafe(current.projectionCachePath)
  const projectionCacheExisted = cacheBefore !== null && cacheBefore.isFile()

  await mkdir(config.trashRoot, { recursive: true })
  try {
    await mkdir(entryDir)
  } catch (error) {
    if (error?.code === 'EEXIST') return { moved: false, reason: 'entry-exists', error: entryName }
    throw error
  }

  const metaPath = path.join(entryDir, 'meta.json')
  try {
    await writeJsonAtomic(
      metaPath,
      buildMeta(config, current, { now, state: 'moving', projectionCacheMoved: false, projectionCacheExisted }),
    )
  } catch (error) {
    await rm(entryDir, { recursive: true, force: true }).catch(() => {})
    return { moved: false, reason: 'meta-write-failed', error: describeError(error) }
  }

  /* ---- 会话目录整体移入 ---- */
  const sessionTarget = path.join(entryDir, 'session')
  try {
    await movePath(current.sessionDir, sessionTarget)
  } catch (error) {
    /* 会话没动：把空条目（含 meta）清掉，下一轮重试。 */
    await rm(entryDir, { recursive: true, force: true }).catch(() => {})
    return { moved: false, reason: 'move-failed', error: describeError(error) }
  }

  /* ---- 投影缓存（尽力而为） ---- */
  let projectionCacheMoved = false
  if (config.moveProjectionCache && projectionCacheExisted) {
    try {
      await movePath(current.projectionCachePath, path.join(entryDir, 'projection-cache.json'))
      projectionCacheMoved = true
    } catch (error) {
      /* 占用/权限：留在原地，DSH 重启后可重建；恢复时目标已存在也不覆盖。 */
      log.warn(`投影缓存未移动 ${candidate.sessionId}：${describeError(error)}`)
    }
  }

  /* ---- 最终 meta ---- */
  try {
    await writeJsonAtomic(
      metaPath,
      buildMeta(config, current, { now, state: 'complete', projectionCacheMoved, projectionCacheExisted }),
    )
  } catch (error) {
    /* 会话已经在回收站里了：保留 moving 状态，7 天后照样按 movedAt 清理。 */
    log.warn(`meta 最终写入失败 ${candidate.sessionId}（保留 state=moving）：${describeError(error)}`)
  }

  return {
    moved: true,
    entryName,
    entryDir,
    bytes: current.sizeBytes,
    ageDays: Number(days(ageMs)),
    projectionCacheMoved,
  }
}

/**
 * 清理回收站：条目满 `trashRetentionDays` 就整条删除。
 *
 * meta 缺失/损坏、`state: "moving"` 的半成品，都用条目目录 mtime 兜底；
 * 删除失败（Windows 占用）跳过，下一轮再试。
 *
 * @param {Record<string, any>} config 规整配置。
 * @param {{ now?: number, dryRun?: boolean, log?: ReturnType<typeof createLogger>, maxEntries?: number }} [options]
 * @returns {Promise<{scanned: number, purged: Array<Record<string, any>>, wouldPurge: Array<Record<string, any>>, kept: number, errors: Array<{entryName: string, error: string}>, bytes: number}>}
 */
export async function purgeTrash(config, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const dryRun = options.dryRun === true
  const log = options.log ?? { debug() {}, info() {}, warn() {}, error() {} }
  const maxEntries = Number.isFinite(options.maxEntries) ? Math.max(0, Math.trunc(options.maxEntries)) : config.maxTrashPurgesPerRun
  const retentionMs = config.trashRetentionDays * DAY_MS
  const result = { scanned: 0, purged: [], wouldPurge: [], kept: 0, errors: [], bytes: 0 }

  let entries
  try {
    entries = await readdir(config.trashRoot, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return result
    throw error
  }

  for (const entry of entries) {
    if (result.purged.length + result.wouldPurge.length >= maxEntries) break
    if (entry.isSymbolicLink()) {
      log.warn(`回收站里有符号链接，跳过：${entry.name}`)
      continue
    }
    if (!entry.isDirectory()) continue
    if (!ENTRY_NAME_RE.test(entry.name)) {
      /* 不是本插件建的目录：不删，只提示。 */
      log.warn(`回收站里有不认识的条目名，跳过：${entry.name}`)
      continue
    }
    result.scanned += 1
    const entryDir = path.join(config.trashRoot, entry.name)

    let meta = null
    let metaError = null
    try {
      meta = await readJson(path.join(entryDir, 'meta.json'))
    } catch (error) {
      metaError = error
    }

    let movedAt = Number.isFinite(Date.parse(meta?.movedAt)) ? Date.parse(meta.movedAt) : null
    let fallback = movedAt === null
    if (movedAt === null) {
      const info = await statSafe(entryDir)
      movedAt = info?.mtimeMs ?? now
    }
    const purgeAfter = Number.isFinite(Date.parse(meta?.purgeAfter))
      ? Date.parse(meta.purgeAfter)
      : movedAt + retentionMs

    const record = {
      entryName: entry.name,
      sessionId: typeof meta?.sessionId === 'string' ? meta.sessionId : null,
      state: typeof meta?.state === 'string' ? meta.state : null,
      ageDays: Number(days(now - movedAt)),
      bytes: 0,
    }

    if (now < purgeAfter) {
      result.kept += 1
      continue
    }

    if (fallback || meta === null || metaError !== null || meta?.state !== 'complete') {
      log.warn(
        `回收站条目 ${entry.name} ${meta === null ? '缺少 meta.json' : `state=${meta?.state ?? '?'}`}，按目录 mtime 兜底清理（${record.ageDays} 天）${metaError ? `：${describeError(metaError)}` : ''}`,
      )
    }

    record.bytes = await dirSize(entryDir)
    if (dryRun) {
      result.wouldPurge.push(record)
      continue
    }
    try {
      await rm(entryDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 150 })
      result.purged.push(record)
      result.bytes += record.bytes
    } catch (error) {
      result.errors.push({ entryName: entry.name, error: describeError(error) })
      log.warn(`回收站条目删除失败，下一轮重试：${entry.name}：${describeError(error)}`)
    }
  }

  return result
}

/* ------------------------------------------------------------------ */
/* 恢复                                                                */
/* ------------------------------------------------------------------ */

/**
 * 找到要恢复的条目目录。
 * @returns {Promise<{entryName: string, entryDir: string}>} 唯一命中。
 */
export async function findTrashEntry(config, { entryName, sessionId } = {}) {
  const entries = await readdirSafe(config.trashRoot, { withFileTypes: true })
  const dirs = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => entry.name)

  if (typeof entryName === 'string' && entryName !== '') {
    if (!ENTRY_NAME_RE.test(entryName)) throw new Error(`不安全的回收站条目名：${entryName}`)
    if (!dirs.includes(entryName)) throw new Error(`回收站里没有这个条目：${entryName}`)
    return { entryName, entryDir: path.join(config.trashRoot, entryName) }
  }

  /* DSH 的会话 id 全是小写；用户从别处粘来的大写 UUID 也接受。 */
  const wanted = typeof sessionId === 'string' ? sessionId.trim().toLowerCase() : sessionId
  if (!isSessionId(wanted)) throw new Error(`不安全的会话 id：${sessionId}`)

  const matches = []
  for (const dir of dirs) {
    if (dir.endsWith(`__${wanted}`)) {
      matches.push(dir)
      continue
    }
    if (!ENTRY_NAME_RE.test(dir)) continue
    try {
      const meta = await readJson(path.join(config.trashRoot, dir, 'meta.json'))
      if (typeof meta?.sessionId === 'string' && meta.sessionId.toLowerCase() === wanted) matches.push(dir)
    } catch {
      /* 读不了 meta 的条目按名字匹配不上就算了 */
    }
  }
  if (matches.length === 0) throw new Error(`回收站里没有会话 ${wanted} 的条目`)
  if (matches.length > 1) {
    throw new Error(
      `会话 ${wanted} 有 ${matches.length} 个回收站条目（${matches.join(', ')}），请改用 --entry 精确指定`,
    )
  }
  return { entryName: matches[0], entryDir: path.join(config.trashRoot, matches[0]) }
}

/**
 * 把一个会话从回收站搬回原位。
 *
 * 只做「文件回位」：不改 `workspace.json`（该 id 本来还在归档集合里），
 * 恢复后必须重启 DSH 才会重新 bootstrap 到该会话。
 *
 * @param {Record<string, any>} config 规整配置。
 * @param {{ entryName?: string, sessionId?: string, dryRun?: boolean, log?: ReturnType<typeof createLogger> }} options
 * @returns {Promise<{restored: boolean, dryRun: boolean, entryName: string, sessionId: string, sessionDir: string, projectionCacheRestored: boolean, projectionCacheLeft: boolean}>}
 */
export async function restoreEntry(config, options = {}) {
  const log = options.log ?? { debug() {}, info() {}, warn() {}, error() {} }
  const dryRun = options.dryRun === true
  const { entryName, entryDir } = await findTrashEntry(config, options)

  let meta
  try {
    meta = await readJson(path.join(entryDir, 'meta.json'))
  } catch (error) {
    throw new Error(`条目 ${entryName} 的 meta.json 不可用：${describeError(error)}`)
  }
  if (meta === null || typeof meta !== 'object') throw new Error(`条目 ${entryName} 缺少 meta.json，无法确定原路径`)
  if (!isSessionId(meta.sessionId)) throw new Error(`条目 ${entryName} 的 meta.sessionId 不合法：${meta.sessionId}`)
  const requested = typeof options.sessionId === 'string' ? options.sessionId.trim().toLowerCase() : undefined
  if (requested !== undefined && requested !== meta.sessionId.toLowerCase()) {
    throw new Error(`条目 ${entryName} 属于 ${meta.sessionId}，不是 ${options.sessionId}`)
  }

  const source = path.join(entryDir, 'session')
  const sourceStat = await lstatSafe(source)
  if (sourceStat === null || !sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`条目 ${entryName} 里没有可恢复的 session/ 目录（meta.state=${meta.state ?? '?'}）`)
  }

  /* ---- 原路径重新做一遍同样的安全闸 ---- */
  const original = typeof meta.originalArtifact === 'string' ? path.resolve(meta.originalArtifact) : ''
  if (original === '' || !ARTIFACT_RE.test(path.basename(original))) {
    throw new Error(`条目 ${entryName} 的 originalArtifact 不合法：${String(meta.originalArtifact)}`)
  }
  const sessionDir = path.dirname(original)
  const workspaceDir = path.dirname(sessionDir)
  const parts = segmentsUnder(config.sessionsRoot, original)
  if (parts === null || parts.length !== 3) {
    throw new Error(`条目 ${entryName} 的原路径不在 sessionsRoot 下的合法深度：${original}`)
  }
  const fold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value)
  if (fold(path.basename(sessionDir)) !== fold(meta.sessionId)) {
    throw new Error(`条目 ${entryName} 的原目录名与会话 id 不一致：${sessionDir}`)
  }
  if (fold(parts[0]) !== fold(path.basename(workspaceDir)) || fold(parts[1]) !== fold(meta.sessionId)) {
    throw new Error(`条目 ${entryName} 的原路径结构不对：${original}`)
  }
  if (
    meta.originalSessionDir !== undefined &&
    meta.originalSessionDir !== null &&
    fold(path.resolve(meta.originalSessionDir)) !== fold(sessionDir)
  ) {
    throw new Error(`条目 ${entryName} 的 originalSessionDir 与 originalArtifact 不一致`)
  }

  /* ---- 目标必须不存在：绝不覆盖 ---- */
  const existing = await lstatSafe(sessionDir)
  if (existing !== null) throw new Error(`目标已存在，拒绝覆盖：${sessionDir}`)

  const cacheSource = path.join(entryDir, 'projection-cache.json')
  const cacheTarget = projectionCachePath(config, meta.sessionId)
  const cacheSourceStat = await lstatSafe(cacheSource)
  const cacheTargetExists = (await lstatSafe(cacheTarget)) !== null

  if (dryRun) {
    return {
      restored: false,
      dryRun: true,
      entryName,
      sessionId: meta.sessionId,
      sessionDir,
      projectionCacheRestored: false,
      projectionCacheLeft: cacheSourceStat !== null && cacheTargetExists,
    }
  }

  await mkdir(workspaceDir, { recursive: true })
  await movePath(source, sessionDir)

  let projectionCacheRestored = false
  let projectionCacheLeft = false
  if (cacheSourceStat !== null) {
    if (cacheTargetExists) {
      /* 已有缓存（多半是 DSH 重启后重建的）：不覆盖，留在条目里。 */
      projectionCacheLeft = true
      log.warn(`恢复 ${meta.sessionId} 时目标缓存已存在，保留条目的 projection-cache.json：${cacheTarget}`)
    } else {
      await mkdir(path.dirname(cacheTarget), { recursive: true })
      await movePath(cacheSource, cacheTarget)
      projectionCacheRestored = true
    }
  }

  if (projectionCacheLeft) {
    /* 条目留着让用户人工比对；7 天后按 trashRetentionDays 清掉。 */
  } else {
    await rm(entryDir, { recursive: true, force: true }).catch(() => {})
  }

  return {
    restored: true,
    dryRun: false,
    entryName,
    sessionId: meta.sessionId,
    sessionDir,
    projectionCacheRestored,
    projectionCacheLeft,
  }
}

/* ------------------------------------------------------------------ */
/* 数据源                                                              */
/* ------------------------------------------------------------------ */

/** `ctx.sessionPersistence.list()`；失败由调用方转成「跳过移动阶段」。 */
export async function loadSnapshots(ctx) {
  const persistence = getService(ctx, 'sessionPersistence')
  if (persistence === undefined || typeof persistence.list !== 'function') {
    throw new Error('sessionPersistence 服务不可用')
  }
  const snapshots = await persistence.list()
  return Array.isArray(snapshots) ? snapshots : []
}

function collectTaskIds(target) {
  const ids = new Set()
  const add = (value) => {
    if (typeof value === 'string' && SESSION_ID_RE.test(value)) ids.add(value)
  }
  add(target?.target?.sessionId)
  if (Array.isArray(target?.involvedSessionIds)) for (const id of target.involvedSessionIds) add(id)
  return ids
}

/** 从 `storages/schedule.json` 读受保护会话 id（catalog 不可用时的回退）。 */
export async function readScheduledIdsFromFile(file) {
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return new Set()
    throw error
  }
  let data
  try {
    data = JSON.parse(raw)
  } catch (error) {
    throw new Error(`schedule 存储不是合法 JSON：${error.message}`)
  }
  const tasks = data?.tables?.tasks
  const ids = new Set()
  if (tasks !== null && typeof tasks === 'object') {
    for (const task of Object.values(tasks)) {
      const status = String(task?.status ?? task?.record?.status ?? '')
      if (status === 'ended' || status === 'inactive') continue
      for (const id of collectTaskIds(task)) ids.add(id)
    }
  }
  return ids
}

/**
 * active / paused 定时任务关联的会话 id。
 *
 * 顺序：`ctx.schedule.catalog()` → `storages/schedule.json` → 抛错（调用方跳过移动阶段）。
 */
export async function collectScheduledSessionIds(ctx, config, log) {
  const schedule = getService(ctx, 'schedule')
  if (schedule !== undefined && typeof schedule.catalog === 'function') {
    try {
      const entries = await schedule.catalog()
      const ids = new Set()
      for (const entry of Array.isArray(entries) ? entries : []) {
        const status = String(entry?.status ?? '')
        if (status !== 'active' && status !== 'paused') continue
        for (const id of collectTaskIds(entry)) ids.add(id)
      }
      return ids
    } catch (error) {
      log?.warn?.(`schedule.catalog() 失败，回退 schedule.json：${describeError(error)}`)
    }
  }
  return readScheduledIdsFromFile(config.scheduleStorePath)
}

/**
 * 收集本轮的保护集合。
 *
 * 任一数据源不可用就抛：宁可这一轮什么都不移，也不凭残缺信息动文件。
 *
 * @returns {Promise<{archived: Set<string>, pinned: Set<string>, live: Set<string>, scheduled: Set<string>, protectedIds: Set<string>}>}
 */
export async function collectProtected(ctx, config, options = {}) {
  const log = options.log
  const registry = getService(ctx, 'workspaceRegistry')
  if (registry === undefined) throw new Error('workspaceRegistry 服务不可用')
  const archived = new Set((registry.archivedSessionIds ?? []).map(String))
  const pinned = new Set((registry.pinnedSessionIds ?? []).map(String))

  const sessions = getService(ctx, 'sessions')
  if (sessions === undefined || typeof sessions.list !== 'function') throw new Error('sessions 服务不可用')
  const live = new Set()
  for (const session of sessions.list()) {
    if (typeof session?.id === 'string') live.add(session.id)
  }

  const scheduled = await collectScheduledSessionIds(ctx, config, log)
  const protectedIds = new Set([...pinned, ...live, ...scheduled])
  return { archived, pinned, live, scheduled, protectedIds }
}

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */

async function writeState(config, summary, log) {
  try {
    const previous = await readJson(config.statePath)
    const stats = previous?.stats !== null && typeof previous?.stats === 'object' ? previous.stats : {}
    const state = {
      version: STATE_VERSION,
      lastRun: summary,
      stats: {
        runsTotal: Number(stats.runsTotal ?? 0) + 1,
        movedTotal: Number(stats.movedTotal ?? 0) + summary.moved,
        purgedTotal: Number(stats.purgedTotal ?? 0) + summary.purged,
        bytesMovedTotal: Number(stats.bytesMovedTotal ?? 0) + summary.bytesMoved,
        bytesPurgedTotal: Number(stats.bytesPurgedTotal ?? 0) + summary.bytesPurged,
        lastDryRunAt: summary.dryRun ? summary.at : (stats.lastDryRunAt ?? null),
        lastRealRunAt: summary.dryRun ? (stats.lastRealRunAt ?? null) : summary.at,
      },
    }
    await writeJsonAtomic(config.statePath, state)
  } catch (error) {
    log.warn(`state 写入失败：${describeError(error)}`)
  }
}

/* ------------------------------------------------------------------ */
/* 单轮编排                                                            */
/* ------------------------------------------------------------------ */

/**
 * 跑一轮：先清回收站，再移归档会话。
 *
 * - 拿不到锁直接跳过本轮（并发安全）；
 * - 清理阶段失败不影响移动阶段，反之亦然；
 * - guard 数据源失败 → 只跳过移动阶段，回收站照样按 7 天规则缩小；
 * - `dryRun` 时只统计与写报告，不建目录、不改名、不删除。
 *
 * @param {any} ctx Cordis 上下文（测试传 `{ get(name) {} }` 桩即可）。
 * @param {Record<string, any>} config 规整配置。
 * @param {{ now?: number, log?: ReturnType<typeof createLogger> }} [options]
 * @returns {Promise<Record<string, any>>} 本轮摘要（同时写进 state.json）。
 */
export async function runOnce(ctx, config, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const ownLogger = options.log === undefined
  const log = options.log ?? createLogger(ctx, config.logFile)

  if (!config.enabled) {
    log.info('run skipped: 插件已禁用')
    if (ownLogger) await log.flush()
    return { skipped: 'disabled' }
  }
  const problems = validateConfig(config)
  if (problems.length > 0) {
    log.error(`run aborted: ${problems.join('；')}`)
    if (ownLogger) await log.flush()
    return { skipped: 'invalid-config', problems }
  }

  let lock
  try {
    lock = await acquireLock(lockPathFor(config), config.lockStaleMs, { now })
  } catch (error) {
    if (error instanceof LockBusyError) {
      log.warn(`run skipped: ${error.message}（${error.detail ?? '?'}）`)
      if (ownLogger) await log.flush()
      return { skipped: 'locked' }
    }
    throw error
  }

  const summary = {
    at: new Date(now).toISOString(),
    ok: true,
    dryRun: config.dryRun,
    scanned: 0,
    archived: 0,
    eligible: 0,
    moved: 0,
    wouldMove: 0,
    purged: 0,
    wouldPurge: 0,
    errors: 0,
    bytesMoved: 0,
    bytesPurged: 0,
    reasons: {},
    durationMs: 0,
  }
  const startedAt = Date.now()
  const noteReason = (reason) => {
    summary.reasons[reason] = (summary.reasons[reason] ?? 0) + 1
  }

  try {
    /* ---- 阶段 1：回收站清理（先删旧，再移新） ---- */
    try {
      const purge = await purgeTrash(config, { now, dryRun: config.dryRun, log, maxEntries: config.maxTrashPurgesPerRun })
      summary.purged = purge.purged.length
      summary.wouldPurge = purge.wouldPurge.length
      summary.bytesPurged = purge.bytes
      summary.errors += purge.errors.length
      for (const record of purge.purged) {
        log.info(`purged trash/${record.entryName} ageDays=${record.ageDays} bytes=${record.bytes}`)
      }
      for (const record of purge.wouldPurge) {
        log.info(`would-purge trash/${record.entryName} ageDays=${record.ageDays} bytes=${record.bytes}`)
      }
    } catch (error) {
      summary.errors += 1
      log.error(`回收站清理失败：${describeError(error)}`)
    }

    /* ---- 阶段 2：归档移动 ---- */
    let snapshots
    try {
      snapshots = await loadSnapshots(ctx)
    } catch (error) {
      summary.errors += 1
      summary.ok = false
      log.error(`会话列表不可用，跳过移动阶段：${describeError(error)}`)
      return summary
    }

    let guards
    try {
      guards = await collectProtected(ctx, config, { log })
    } catch (error) {
      summary.errors += 1
      summary.ok = false
      log.error(`guard 数据源不可用，跳过移动阶段：${describeError(error)}`)
      return summary
    }

    summary.scanned = snapshots.length
    summary.archived = guards.archived.size

    const plan = await planMoves({
      config,
      now,
      snapshots,
      archived: guards.archived,
      protectedIds: guards.protectedIds,
    })
    summary.eligible = plan.eligible
    for (const [reason, count] of Object.entries(plan.reasons)) summary.reasons[reason] = count
    for (const skip of plan.skipped) {
      const detail = skip.ageDays !== undefined ? ` ageDays=${skip.ageDays}` : ''
      log.debug(`skip ${skip.sessionId ?? '?'} reason=${skip.reason}${detail}${skip.detail ? ` detail=${skip.detail}` : ''}`)
    }

    if (config.dryRun) {
      summary.wouldMove = plan.candidates.length
      for (const candidate of plan.candidates) {
        log.info(
          `would-move ${candidate.sessionId} -> trash/${entryNameFor(now, candidate.sessionId)} (${formatBytes(candidate.sizeBytes)}, ageDays=${days(candidate.ageMs)})`,
        )
      }
      return summary
    }

    const movedIds = new Set()
    for (const candidate of plan.candidates) {
      /* 运行时再验一次：父会话前面，所有子会话必须已经成功搬走。 */
      const pending = (candidate.childIds ?? []).filter((id) => !movedIds.has(id))
      if (pending.length > 0) {
        noteReason('children-not-moved')
        log.warn(`skip ${candidate.sessionId} reason=children-not-moved pending=${pending.join(',')}`)
        continue
      }
      let moved
      try {
        moved = await moveOne(config, candidate, { now, log })
      } catch (error) {
        summary.errors += 1
        log.error(`移动失败 ${candidate.sessionId}：${describeError(error)}`)
        continue
      }
      if (moved.moved !== true) {
        noteReason(moved.reason ?? 'move-failed')
        log.warn(`skip ${candidate.sessionId} reason=${moved.reason ?? 'move-failed'}${moved.error ? ` error=${moved.error}` : ''}`)
        continue
      }
      movedIds.add(candidate.sessionId)
      summary.moved += 1
      summary.bytesMoved += moved.bytes ?? 0
      log.info(
        `moved ${candidate.sessionId} -> trash/${moved.entryName} (${formatBytes(moved.bytes)}, ageDays=${days(candidate.ageMs)})${moved.projectionCacheMoved ? '' : ' [投影缓存保留在原位]'}`,
      )
    }
    return summary
  } finally {
    try {
      await lock.release()
    } catch {
      /* 锁释放失败只会让下一轮多等一个 staleMs */
    }
    summary.durationMs = Date.now() - startedAt
    await writeState(config, summary, log)
    log.info(
      `run scanned=${summary.scanned} archived=${summary.archived} eligible=${summary.eligible} moved=${summary.moved} purged=${summary.purged} errors=${summary.errors} dryRun=${config.dryRun}`,
    )
    const reasonText = Object.entries(summary.reasons)
      .map(([reason, count]) => `${reason}=${count}`)
      .join(' ')
    if (reasonText !== '') log.info(`skips ${reasonText}`)
    if (summary.dryRun && (summary.wouldMove > 0 || summary.wouldPurge > 0)) {
      log.info(`dry-run 未改动任何文件：wouldMove=${summary.wouldMove} wouldPurge=${summary.wouldPurge}`)
    }
    if (ownLogger) await log.flush()
  }
}

/* ------------------------------------------------------------------ */
/* 插件入口                                                            */
/* ------------------------------------------------------------------ */

/**
 * Cordis 插件体。
 *
 * 启动后 `startupDelayMs`（默认 60 秒）跑第一轮，之后每 `intervalMinutes`
 * （默认 1440 = 24 小时）一轮。`inFlight` 保证上一轮没结束就跳过下一轮；
 * 文件锁保证多进程（例如同时开了 CLI 的 restore）不会双移。
 *
 * @param {any} ctx Cordis 上下文。
 * @param {Record<string, any>} [rawConfig] `cordis.patch.yml` 里的 `config`。
 */
export async function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const log = createLogger(ctx, config.logFile)

  if (!config.enabled) {
    log.info('插件已禁用（enabled: false），不调度任何运行')
    return
  }
  const problems = validateConfig(config)
  if (problems.length > 0) {
    log.error(`配置有问题，插件不启动：${problems.join('；')}`)
    return
  }

  log.info(
    `启动：dryRun=${config.dryRun} archiveRetentionDays=${config.archiveRetentionDays} trashRetentionDays=${config.trashRetentionDays} intervalMinutes=${config.intervalMinutes} startupDelayMs=${config.startupDelayMs} sessionsRoot=${config.sessionsRoot} trashRoot=${config.trashRoot}`,
  )

  let inFlight = null
  let disposed = false
  let intervalTimer = null
  let startupTimer = null

  const trigger = (reason) => {
    if (disposed) return Promise.resolve(null)
    if (inFlight !== null) {
      log.warn(`${reason} tick 跳过：上一轮还在运行`)
      return inFlight
    }
    inFlight = runOnce(ctx, config, { log })
      .catch((error) => {
        log.error(`run 异常：${describeError(error)}`)
        return null
      })
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }

  const start = () => {
    startupTimer = setTimeout(() => {
      startupTimer = null
      void trigger('startup')
    }, config.startupDelayMs)
    startupTimer.unref?.()
    intervalTimer = setInterval(() => {
      void trigger('interval')
    }, config.intervalMinutes * 60_000)
    intervalTimer.unref?.()
  }

  const stop = () => {
    disposed = true
    if (startupTimer !== null) {
      clearTimeout(startupTimer)
      startupTimer = null
    }
    if (intervalTimer !== null) {
      clearInterval(intervalTimer)
      intervalTimer = null
    }
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      start()
      return stop
    }, 'session-purge 定时器')
  } else {
    start()
  }

  return async () => {
    stop()
    await log.flush()
  }
}
