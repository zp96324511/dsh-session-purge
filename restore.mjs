#!/usr/bin/env node
/**
 * dsh-session-purge 的恢复 CLI。
 *
 * 插件把会话搬进回收站后，DSH 重启就会按「缺失 header」把它从列表里过滤掉。
 * 要找回文件，用这个脚本把它搬回原位：
 *
 *   node restore.mjs --list
 *   node restore.mjs --session session-209ac311-fe6f-4bc4-bdfc-bfa8bbbe8a27
 *   node restore.mjs --entry 20261113T014500123Z__session-209ac311-fe6f-4bc4-bdfc-bfa8bbbe8a27
 *
 * 恢复只做「文件回位」：不修改 workspace.json（该 id 本来还在归档集合里），
 * 恢复后必须重启 `dsh web`，运行中的宿主才会重新 bootstrap 到该会话。
 *
 * 与插件共用同一把锁（`state.json.lock`），不会和正在跑的一轮互相踩。
 */

import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  createLogger,
  formatBytes,
  lockPathFor,
  normalizeConfig,
  readJson,
  restoreEntry,
  withLock,
} from './index.js'

/* index.js 不导出条目名正则（条目名只经 trashEntryDir 构造/校验），
 * 这里用与它等价的判定：只展示本插件建出来的条目。 */
const ENTRY_PATTERN =
  /^\d{8}T\d{6}\d{3}Z__session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const HELP = `dsh-session-purge restore

用法：
  node restore.mjs --list                      列出回收站条目
  node restore.mjs --session <session-id>      按会话 id 恢复
  node restore.mjs --entry <entry-name>        按条目名恢复

选项：
  --dry-run                只显示将要做什么，不移动文件
  --dsh-home <path>        DSH home（缺省 $DSH_HOME，再缺省 ~/.dsh）
  --trash-root <path>      覆盖回收站路径（缺省 <home>/session-purge/trash）
  --json                   以 JSON 输出结果
  -h, --help               显示本帮助
`

/**
 * 打印回收站清单。
 * @param {Record<string, any>} config 规整配置。
 * @param {{ json?: boolean, write?: (line: string) => void }} [options]
 * @returns {Promise<Array<Record<string, any>>>} 条目记录。
 */
export async function listTrash(config, options = {}) {
  const write = options.write ?? ((line) => process.stdout.write(`${line}\n`))
  let entries = []
  try {
    entries = await readdir(config.trashRoot, { withFileTypes: true })
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const names = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && ENTRY_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort()
  const rows = []
  for (const entryName of names) {
    const entryDir = path.join(config.trashRoot, entryName)
    let meta = null
    let metaError = null
    try {
      meta = await readJson(path.join(entryDir, 'meta.json'))
    } catch (error) {
      metaError = error?.message ?? String(error)
    }
    let hasSession = false
    try {
      await readdir(path.join(entryDir, 'session'))
      hasSession = true
    } catch {
      hasSession = false
    }
    const movedAt = Number.isFinite(Date.parse(meta?.movedAt)) ? Date.parse(meta.movedAt) : null
    const purgeAfter = Number.isFinite(Date.parse(meta?.purgeAfter)) ? Date.parse(meta.purgeAfter) : null
    rows.push({
      entryName,
      sessionId: typeof meta?.sessionId === 'string' ? meta.sessionId : entryName.slice(entryName.indexOf('__') + 2),
      state: typeof meta?.state === 'string' ? meta.state : null,
      sizeBytes: Number.isFinite(meta?.sizeBytes) ? meta.sizeBytes : null,
      movedAt: movedAt === null ? null : new Date(movedAt).toISOString(),
      purgeAfter: purgeAfter === null ? null : new Date(purgeAfter).toISOString(),
      ageDays: movedAt === null ? null : Number(((Date.now() - movedAt) / 86_400_000).toFixed(1)),
      hasSession,
      metaError,
    })
  }

  if (options.json === true) {
    write(JSON.stringify({ trashRoot: config.trashRoot, entries: rows }, null, 2))
    return rows
  }

  write(`回收站：${config.trashRoot}`)
  if (rows.length === 0) {
    write('（空）')
    return rows
  }
  write(`共 ${rows.length} 个条目`)
  for (const row of rows) {
    const size = row.sizeBytes === null ? '?' : formatBytes(row.sizeBytes)
    const age = row.ageDays === null ? '?' : `${row.ageDays} 天`
    const state = row.state ?? '缺少 meta'
    const flags = [row.hasSession ? 'session/' : '缺少 session/', row.metaError ? `meta 读取失败：${row.metaError}` : '']
      .filter(Boolean)
      .join('，')
    write(`${row.entryName}`)
    write(`  session=${row.sessionId} state=${state} 大小=${size} 已存放=${age} 清理时间=${row.purgeAfter ?? '?'}`)
    write(`  ${flags}`)
  }
  return rows
}

async function main(argv = process.argv.slice(2)) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        list: { type: 'boolean', default: false },
        session: { type: 'string' },
        entry: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        'dsh-home': { type: 'string' },
        'trash-root': { type: 'string' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    })
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  const values = parsed.values
  if (values.help === true) {
    process.stdout.write(HELP)
    return 0
  }

  const home = typeof values['dsh-home'] === 'string' ? values['dsh-home'] : undefined
  const config = normalizeConfig(
    {
      trashRoot: values['trash-root'],
      dryRun: false,
    },
    home,
  )

  if (values.list === true) {
    await listTrash(config, { json: values.json === true })
    return 0
  }

  const entryName = typeof values.entry === 'string' ? values.entry : undefined
  const sessionId = typeof values.session === 'string' ? values.session : undefined
  if (entryName === undefined && sessionId === undefined) {
    process.stderr.write(`需要 --list、--entry 或 --session 之一\n\n${HELP}`)
    return 2
  }
  if (entryName !== undefined && sessionId !== undefined) {
    process.stderr.write('--entry 与 --session 只能二选一\n')
    return 2
  }

  const log = createLogger(undefined, config.logFile)
  let result
  try {
    result = await withLock(lockPathFor(config), config.lockStaleMs, () =>
      restoreEntry(config, {
        entryName,
        sessionId,
        dryRun: values['dry-run'] === true,
        log,
      }),
    )
  } catch (error) {
    if (error?.name === 'LockBusyError') {
      process.stderr.write(`回收站正被插件使用（${error.message}），稍后重试。\n`)
      return 3
    }
    process.stderr.write(`恢复失败：${error?.message ?? String(error)}\n`)
    return 1
  } finally {
    await log.flush()
  }

  if (values.json === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else if (result.dryRun) {
    process.stdout.write(`[dry-run] 将把 ${result.entryName} 恢复到：\n  ${result.sessionDir}\n`)
    if (result.projectionCacheRestored) process.stdout.write('  （投影缓存会一并移回）\n')
  } else {
    process.stdout.write(`已恢复 ${result.sessionId}\n`)
    process.stdout.write(`  session 目录：${result.sessionDir}\n`)
    process.stdout.write(
      `  投影缓存：${result.projectionCacheRestored ? '已移回' : result.projectionCacheLeft ? '目标已存在，未覆盖（留在回收站条目里）' : '条目里没有缓存'}\n`,
    )
    process.stdout.write('\n重启 dsh web 后，该会话才会重新出现在列表里（本脚本不会热加载）。\n')
  }
  return 0
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      process.stderr.write(`未处理的错误：${error?.stack ?? String(error)}\n`)
      process.exitCode = 1
    })
}
