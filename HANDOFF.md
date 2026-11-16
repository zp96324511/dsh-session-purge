# dsh-session-purge 会话交接文档

> 交接时间：2026-11-13（Asia/Shanghai）
> 来源会话：`default-workspace`，DSH `0.2.2-rc.1`，Node `v26.10.0`
> 目标工作区：`C:\data\projects\dsh-session-purge`
> 当前状态：**设计定稿，代码尚未编写**。新会话从本文件开始实施。

---

## 0. 一句话目标

写一个 DSH 插件 `dsh-session-purge`，每天扫描一次**已归档且会话文件 mtime 超过 30 天**的会话，把整个会话目录和投影缓存**移动**到独立回收站；回收站里的条目满 **7 天**后再彻底删除。

不是直接 `rm`。第一段是“归档 → 回收站”，第二段是“回收站 → 物理删除”，两段使用不同的保留期。

---

## 1. 用户已确认的决策

| # | 决策 | 说明 |
|---|---|---|
| 1 | 时间口径用 **mtime** | 会话文件 `session.v4.jsonl.zstd` 的最后写入时间超过 `archiveRetentionDays`（默认 30 天），且该会话当前在归档集合里，才移动。不是“归档满 30 天”（DSH 没有 `archivedAt`）。 |
| 2 | 扫描间隔 **每天一次** | `intervalMinutes: 1440`；启动后延迟 60 秒先跑一次，之后每 24 小时一次。不是固定钟点（除非用户后续要求）。 |
| 3 | 删除 = **移动到回收站** | 不直接删。移动后原 `~/.dsh/sessions` 下不再有该会话，DSH 重启后自然看不到。 |
| 4 | 回收站 **单独维护 7 天规则** | 回收站条目从 `movedAt` 起算，满 `trashRetentionDays`（默认 7 天）后，在下一次每日运行时彻底删除。 |
| 5 | 回收站是独立目录 | 建议 `C:\Users\win10\.dsh\session-purge\trash`；**不能**放在 `~/.dsh/sessions` 下面，否则会被 DSH 当成会话扫描。 |
| 6 | 先 dry-run | 插件默认 `dryRun: true`；第一次真实运行前先看报告。 |
| 7 | 不改 `workspace.json` | 归档 id 保留；DSH 重启后按缺失 header 自动过滤。没有公开 API，运行中改会产生缓存不一致。 |
| 8 | 不碰共享数据 | 不删 `attachments/v1`，不删 `sessions-archive`，不删 `fast-search.db`（索引行由 fast-search 自己的 watcher 清理）。 |

---

## 2. 本机事实（2026-11-13 实测，直接可用）

### 2.1 版本与路径

- DSH CLI：`0.2.2-rc.1`
- Node：`v26.10.0`
- DSH home：`C:\Users\win10\.dsh`
- 会话根：`C:\Users\win10\.dsh\sessions`
- 每个会话一个目录：
  `C:\Users\win10\.dsh\sessions\<规范化cwd目录>\session-<uuid>\session.v4.jsonl.zstd`
- 归档集合：`C:\Users\win10\.dsh\storages\workspace.json`
  - `global.archivedSessionIds`：字符串数组，**没有时间戳**
  - `global.pinnedSessionIds`：字符串数组
  - `tables.workspaces.<id>`：`{path,title,sessionIds,createdAt,updatedAt}`
- 投影缓存：`C:\Users\win10\.dsh\storages\session_projcache\sessions\session-<uuid>.json`
- 定时任务：`C:\Users\win10\.dsh\storages\schedule.json`
  - `tables.tasks.<schedule-id>`：`{record,involvedSessionIds,status,target,...}`
  - `target.sessionId`、`involvedSessionIds`、`status: active|paused|ended`
- fast-search：`C:\Users\win10\.dsh\storages\fast-search.db`（另有 `-wal`）
- profile：`C:\Users\win10\.dsh\profiles\web\package.json`
- profile patch：`C:\Users\win10\.dsh\profiles\web\cordis.patch.yml`
- 手工归档副本：`C:\Users\win10\.dsh\sessions-archive\2026-11-07-empty\...`

### 2.2 磁盘数据

| 项目 | 实测 |
|---|---|
| `global.archivedSessionIds` | **86 个** |
| 在 `~/.dsh/sessions` 有真实目录的归档会话 | **48 个，合计 11.58 MB** |
| 无 live 文件的归档 id | 38 个；全部能在 `sessions-archive\2026-11-07-empty` 找到副本 |
| `sessions-archive` | 5302 个 `session-*` 目录，合计仅 1.74 MB（多为空壳） |
| 48 个归档会话文件的 mtime 年龄 | **2.1–24.9 天；≥30 天的 0 个** |
| 归档会话对应的投影缓存 | 86 个 json，0.53 MB |
| 全部 sessions | 182 个目录，135.51 MB |
| 全部投影缓存 | 5484 个 json，26.56 MB |
| `fast-search.db` | 292.68 MB + WAL 5.6 MB |

**重要结论**：今天按 mtime 30 天规则运行，`eligible` 应为 **0**。这不是插件没工作；48 个文件的最后写入都不到 25 天。不要为了“看到效果”把 30 天临时改成 0 去跑真实数据；用临时 fixture 测。

### 2.3 DSH 归档机制的关键限制

1. 归档只写 `workspace.json` 的 `global.archivedSessionIds`，**不碰会话文件**。
2. 没有 `archivedAt`；`SessionHeader` 只有 `createdAt`，没有 `updatedAt`。
3. 官方没有删除会话的 seam：
   - `dsh-session-persistence-jsonl/README.zh.md` 第 167 行：
     “不删除会话文件——日志在 root 下累积，直到外部移除；seam 无删除接口。”
   - `dsh-workspace/README.zh.md` 第 118 行：
     “归档与置顶集合存储会话 id 字符串……不包含逐项对象或时间戳。”
   - 第 169 行：“移除绝不删除数据。”
4. `Workspace.sessionIds` 的过滤依赖启动时建立的 `sessionPaths` 内存 Map；外部移走文件后，**运行中的进程不会立即感知**，重启后才从列表消失。
5. 删除/移动文件后，`workspace.json` 里的归档 id 仍会保留（仅字符串，体积可忽略）。不要直接改它。

---

## 3. 目标行为（验收口径）

### 3.1 每日运行的两个阶段

一次每日 tick 内按顺序执行：

1. **回收站清理阶段**：扫描 `trashRoot` 的条目，`now - movedAt >= 7 天` 的条目彻底删除。
2. **归档移动阶段**：扫描 `~/.dsh/sessions`，把满足条件的归档会话移动到 `trashRoot`。

先清理、后移动：即使移动阶段因 guard 失败中止，回收站仍能按 7 天规则缩小。

“回收站单独维护规则”指**保留期和判定逻辑独立**（7 天 vs 30 天），v1 仍共用同一个每日 tick；如果以后希望回收站清理更频繁，再拆第二个 `ctx.interval`。

### 3.2 移动条件（全部满足）

- 会话 id 在 `ctx.workspaceRegistry.archivedSessionIds` 里；
- 不是进程内活会话（`ctx.sessions.list()` / `get(id)`）；
- 不在 `pinnedSessionIds`；
- 不是 `active` 或 `paused` 定时任务的 `target.sessionId`，也不在它们的 `involvedSessionIds`；
- 会话文件存在，且 `now - mtimeMs >= archiveRetentionDays * 86400000`；
- 路径校验通过（见 5.6）；
- 家族校验通过（见 5.5）。

### 3.3 回收站清理条件

- 条目 `meta.json` 可读：`now >= purgeAfter`（`purgeAfter = movedAt + trashRetentionDays`）；
- `meta.json` 缺失/损坏：用条目目录 mtime 作为 `movedAt` 的兜底，满 7 天也删；日志 warn；
- `state: "moving"` 的半成品：满 7 天也删（它本来就在被移入回收站）；日志 warn；
- 删除失败（Windows `EBUSY/EPERM`）：跳过，下一轮重试。

### 3.4 明确不做

- 不直接 `rm` 归档会话（必须先经过回收站）；
- 不改 `workspace.json`；
- 不删 `attachments`、`sessions-archive`、`fast-search.db`；
- 不做在线 SQLite `VACUUM`；
- 不自动恢复；恢复用 `restore.mjs` CLI；
- 不处理 38 个“无 live 文件、只在 `sessions-archive` 有副本”的归档 id（它们不在 `~/.dsh/sessions`，没有 mtime 可算）；
- 不注册回收站为 DSH workspace。

---

## 4. 回收站设计

### 4.1 目录布局

```text
C:\Users\win10\.dsh\session-purge\
  state.json                 # 最近运行、累计统计（可选，但建议有）
  state.json.lock            # 单飞锁
  trash\
    20261113T014500123Z__session-209ac311-fe6f-4bc4-bdfc-bfa8bbbe8a27\
      meta.json
      session\               # 原 session-<uuid> 目录整体移入
        session.v4.jsonl.zstd
        ...                  # 原目录里的其他文件一并保留
      projection-cache.json  # 原投影缓存（存在才移）
```

条目名格式：`YYYYMMDDTHHMMSSmmmZ__<sessionId>`（UTC，毫秒，字典序即时间序）。
不要把条目直接放在 `trash\session-<uuid>`：时间戳在名字里，清理时不必读 meta 就能排序；也避免同名冲突。

### 4.2 `meta.json` schema

```json
{
  "version": 1,
  "state": "moving",
  "sessionId": "session-209ac311-fe6f-4bc4-bdfc-bfa8bbbe8a27",
  "workspaceDir": "--C-Users-win10-Documents-deepseek-harness-default-workspace--",
  "originalSessionDir": "C:\\Users\\win10\\.dsh\\sessions\\--C-Users-...--\\session-209ac311-...",
  "originalArtifact": "C:\\Users\\win10\\.dsh\\sessions\\--C-Users-...--\\session-209ac311-...\\session.v4.jsonl.zstd",
  "originalProjectionCache": "C:\\Users\\win10\\.dsh\\storages\\session_projcache\\sessions\\session-209ac311-....json",
  "artifactMtime": "2026-10-20T10:00:00.000Z",
  "sizeBytes": 133355,
  "movedAt": "2026-11-13T01:45:00.123Z",
  "purgeAfter": "2026-11-20T01:45:00.123Z",
  "reason": "archived-and-idle",
  "pluginVersion": "0.1.0"
}
```

- `state`：先写 `moving`，移动成功并写完 cache 后改 `complete`。
- `originalProjectionCache`：缓存不存在时为 `null`。
- `movedAt` / `purgeAfter`：移动开始时确定；崩溃后半成品也按这个时间清理。
- `artifactMtime`：移动时的源文件 mtime，便于审计“为什么它被选中”。
- `sizeBytes`：会话文件大小（不是整个目录）。
- `workspaceDir`：原会话目录的父目录名，恢复时用于校验。

### 4.3 移动算法（逐会话）

```text
moveOne(session):
  validate guards again (archived, not live, not pinned, not scheduled)
  stat artifact; if now - mtime < archiveRetentionDays: skip
  resolve & validate paths (see 5.6)
  entryName = utcCompact(now) + "__" + sessionId
  entryDir = trashRoot/entryName
  mkdir(entryDir)
  write meta(state="moving", movedAt=now, purgeAfter=now+7d, ...)
  rename(sessionDir, entryDir/session)        # 同卷原子
    if EXDEV: cp(sessionDir, entryDir/session, {recursive, preserveTimestamps}) then rm(sessionDir)
  if projection cache exists:
    rename(cache, entryDir/projection-cache.json)
      if EXDEV: copyFile + rm
      if EBUSY/EPERM: 记录 warn，保留原缓存，meta 标记 projectionCacheMoved=false
  write meta(state="complete", projectionCacheMoved=...)
  log moved
```

失败处理：

- `rename(sessionDir, entryDir/session)` 失败：删掉空的 `entryDir`（如果 meta 已写也删）；原会话不动；下一轮重试。
- 会话已移入、cache 移动失败：**不回滚**（回滚会和 DSH 的打开/缓存竞争）；meta 记为 `complete` + `projectionCacheMoved:false`，原 cache 留在原地；日志 warn；重启后 cache 可能被 DSH 重建。
- 最终 meta 写入失败：保留 `state:"moving"`；会话已在回收站；7 天后按 `moving` 清理；`restore.mjs` 仍可识别 `session/` 并恢复。
- 任何异常都记 `summary.errors`，不影响同轮其他会话。

### 4.4 恢复算法（`restore.mjs`）

```text
restore(entryNameOrSessionId):
  acquire same lock (state.json.lock)
  find entry dir; read meta
  if meta.state !== "complete" and entry/session missing: abort
  validate originalSessionDir:
    - 必须在 sessionsRoot 下，相对路径恰好两层
    - basename == sessionId
    - 目标不存在（存在则 abort，绝不覆盖）
  mkdir(parent(originalSessionDir))
  rename(entry/session, originalSessionDir)
    if EXDEV: cp + rm
  if entry/projection-cache.json exists:
    if target cache missing: rename back
    else: warn, leave in entry
  remove entry dir (meta + empty cache)
  print "restored; restart dsh web to see it"
```

- 恢复后**必须重启 DSH**，运行中的进程才会重新 bootstrap 到该会话。
- 恢复只做“文件回位”，不修改 `workspace.json`；该 id 本来还在归档集合里，重启后它会重新出现在归档视图。
- 如果用户已经手工把原目录放回，`restore` 检测到目标存在就 abort，避免覆盖。
- 同一个 session 理论上只应有一个 trash 条目；如果发现多个（例如上次移动半失败后又移了一次），`--session` 必须 abort 并提示改用 `--entry` 精确指定。

### 4.5 彻底删除算法

```text
purgeTrash():
  for entryDir in readdir(trashRoot):
    if not directory: continue
    meta = read meta.json (may fail)
    movedAt = meta.movedAt or stat(entryDir).mtimeMs
    purgeAfter = meta.purgeAfter or movedAt + trashRetentionDays
    if now < purgeAfter: continue
    rm(entryDir, {recursive, force, maxRetries:2})
    log bytes freed
```

- 先删旧、再移新；删除失败不影响移动阶段。
- `maxTrashPurgesPerRun` 默认 100，防止异常堆积时一次卡太久。
- 删除的是整个条目目录，包括 `meta.json`、`session/`、`projection-cache.json`。

---

## 5. 插件设计

### 5.1 名字与形态

- 包名/插件名：`dsh-session-purge`
- 单文件 ESM：`index.js`
- 零外部依赖，只用 `node:fs/promises`、`node:os`、`node:path`
- 导出：

```js
export const name = 'dsh-session-purge';
export async function apply(ctx, config = {}) { ... }
```

### 5.2 触发

```js
ctx.effect(() => {
  const startup = setTimeout(() => { startInterval(); void runOnce(); }, startupDelayMs);
  // ctx.interval(callback, intervalMs) 随 fiber 释放
  return () => { clearTimeout(startup); disposeInterval?.(); };
});
```

- `startupDelayMs` 默认 60000。
- `intervalMinutes` 默认 1440（每天）。
- `ctx.interval` 不可用时回退 `setInterval` + `unref()`。
- single-flight：`inFlight` Promise；上一轮没结束就跳过。
- 文件锁：`state.json.lock`，`open(lockPath, 'wx')`；stale > `lockStaleMs` 才抢；`restore.mjs` 用同一把锁。

### 5.3 数据源

```js
const snapshots = await ctx.sessionPersistence.list();       // 全部会话快照
const archived = new Set(ctx.workspaceRegistry.archivedSessionIds);
const pinned = new Set(ctx.workspaceRegistry.pinnedSessionIds);
const live = new Set(ctx.sessions.list().map(s => s.id));    // 活会话
const schedule = ctx.get('schedule');                        // 可选
const tasks = schedule?.catalog ? await schedule.catalog() : readScheduleJson();
```

`SessionPersistenceSnapshot` 关键字段：

```ts
{
  header: { version, id, createdAt, cwd?, parentSession?, isSeeded, origin?, delegationDepth? },
  location?: { kind: 'jsonl', path: string },
  sizeBytes?: number,
  revision,
  eventCount?,
  formatStatus?
}
```

- `header` 没有 `updatedAt` / `archivedAt`。
- `location.path` 指向 `...\session-<uuid>\session.v4.jsonl.zstd`。
- `list()` 每次会扫盘 stat，ENOENT 条目跳过；单条损坏可能让整次 `list()` 拒绝 → 捕获后跳过移动阶段，仍执行回收站清理。

### 5.4 时间判定

```js
const statInfo = await stat(snapshot.location.path);
const ageMs = Date.now() - statInfo.mtimeMs;
const eligible = ageMs >= archiveRetentionDays * 86_400_000;
```

- 只用会话文件 mtime，不用目录 mtime、不用 `createdAt`、不用投影缓存 mtime。
- mtime 可能被 DSH 的格式迁移/修复重写；这会让会话“变年轻”，延迟移动，不会提前误删。
- 时钟回拨/未来 mtime：`ageMs` 为负 → 不移动。

### 5.5 家族（subagent）保护

DSH 的 subagent 会话有 `header.parentSession`。移动父会话时如果子会话还留着，父日志可能引用缺失的子日志；反之亦然。

规则：

1. 用全部 snapshots 建 `parent -> children` 映射（包括 live）。
2. 对每个候选，沿 `parent` 和 `children` 做 BFS，得到“家族连通分量”。
3. 家族里只要有一个成员：
   - 是 live / pinned / schedule-protected；
   - 或不是归档；
   - 或 mtime 未满 30 天；
   - 或路径不安全；
   则整个家族本轮都不移动。
4. 全部成员都可移动时，按 `depth` 降序（子先父后）移动。
5. 运行时用 `movedIds` 再检查一次：父移动前，所有子必须已成功移动；否则跳过父，下一轮重试。
6. `maxMovesPerRun` 截断后，再做一次家族过滤，避免“家族只移了一半”。

注意：家族过滤是保守策略，可能让某些老会话多等几天；安全优先。

### 5.6 安全闸与路径校验

必须全部满足：

- `sessionId` 匹配 `^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`
- `location.kind === 'jsonl'`
- `resolve(location.path)` 后：
  - `basename(artifact)` 匹配 `^session\.v\d+\.jsonl(?:\.zstd)?$`
  - `basename(sessionDir) === sessionId`
  - `dirname(sessionDir)` 是 sessionsRoot 的直接子目录（规范化 cwd 目录）
  - 相对 `sessionsRoot` 的路径恰好 3 段（workspaceDir / sessionId / artifact）
  - 不是符号链接：`lstat(sessionDir)` 和 `lstat(artifact)` 都必须是真实目录/文件
- 回收站目标必须在 `trashRoot` 下；条目名只允许 `[A-Za-z0-9TZ_-]` 和 session id 字符
- 恢复时 `originalSessionDir` 必须重新做同样的路径校验；目标存在则 abort
- Windows 下 `sessionsRoot` / `trashRoot` 的前缀比较建议先 `resolve` 再统一 `toLowerCase()`，避免盘符/用户名大小写差异造成误判
- 任何 guard 数据源失败（workspaceRegistry / sessions / schedule catalog / schedule.json 非 ENOENT 读取失败）→ **跳过移动阶段**，不删任何会话；回收站清理可继续

不做的事：

- 不跟随 junction/symlink 删除目标；发现符号链接直接 skip。
- 不删除 `sessionsRoot` 之外的任何路径。
- 不把回收站放在 `sessionsRoot` 下。

### 5.7 投影缓存

- 移动会话成功后，把 `~/.dsh/storages/session_projcache/sessions/<id>.json` 移到条目里的 `projection-cache.json`。
- 缓存不存在：正常，meta `originalProjectionCache: null`。
- 缓存被占用（`EBUSY/EPERM`）：保留原缓存，meta `projectionCacheMoved:false`，日志 warn；重启后 DSH 可重建。
- 恢复时把缓存移回；目标已存在则保留条目的缓存并 warn，不覆盖。
- 不把缓存当时间依据。

### 5.8 日志与状态

日志：`C:\Users\win10\.dsh\logs\session-purge.log`

每次运行一行摘要，例如：

```text
[2026-11-13T...] [info] run scanned=182 archived=86 eligible=0 moved=0 purged=0 errors=0 dryRun=true
[2026-11-13T...] [info] skip session-... reason=not-eligible ageDays=24.9
[2026-11-13T...] [info] moved session-... -> trash/20261113T...__session-... (11.2 MB)
[2026-11-13T...] [info] purged trash/20261106T...__session-... (7.0 days)
```

状态：`C:\Users\win10\.dsh\session-purge\state.json`

```json
{
  "version": 1,
  "lastRun": { "at": "...", "ok": true, "scanned": 182, "archived": 86, "eligible": 0, "moved": 0, "purged": 0, "errors": 0, "dryRun": true, "durationMs": 123 },
  "stats": { "movedTotal": 0, "purgedTotal": 0, "bytesMovedTotal": 0, "bytesPurgedTotal": 0 }
}
```

状态不是正确性来源；回收站 `meta.json` 才是。状态损坏时重建即可。

---

## 6. 配置

`cordis.patch.yml` 里的默认配置：

```yaml
- insert:
    - id: session-purge
      name: dsh-session-purge
      config:
        enabled: true
        dryRun: true
        archiveRetentionDays: 30
        trashRetentionDays: 7
        intervalMinutes: 1440
        startupDelayMs: 60000
        maxMovesPerRun: 50
        maxTrashPurgesPerRun: 100
        moveProjectionCache: true
        trashRoot: C:\Users\win10\.dsh\session-purge\trash
        statePath: C:\Users\win10\.dsh\session-purge\state.json
        logFile: C:\Users\win10\.dsh\logs\session-purge.log
        lockStaleMs: 600000
```

配置项说明：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉插件但不卸载 |
| `dryRun` | `true` | 只报告，不移动、不删除 |
| `archiveRetentionDays` | `30` | 会话文件 mtime 超过多少天可移入回收站 |
| `trashRetentionDays` | `7` | 回收站条目满多少天彻底删除 |
| `intervalMinutes` | `1440` | 每日一次；从启动后首跑开始计时 |
| `startupDelayMs` | `60000` | 启动后延迟，避开宿主启动 I/O |
| `maxMovesPerRun` | `50` | 单轮最多移动多少会话 |
| `maxTrashPurgesPerRun` | `100` | 单轮最多彻底删除多少条目 |
| `moveProjectionCache` | `true` | 是否把投影缓存一起移入回收站 |
| `trashRoot` | `~/.dsh/session-purge/trash` | 回收站根；必须与 sessions 同卷（否则 copy 回退） |
| `statePath` | `~/.dsh/session-purge/state.json` | 状态与锁路径 |
| `logFile` | `~/.dsh/logs/session-purge.log` | 日志 |
| `lockStaleMs` | `600000` | 锁超过 10 分钟视为 stale |

`DSH_HOME` 非空时，`~/.dsh` 用 `DSH_HOME` 替代；配置里的绝对路径优先。

---

## 7. 项目文件

```text
C:\data\projects\dsh-session-purge\
  HANDOFF.md              # 本文件
  index.js                # 插件实现
  package.json            # type=module, dsh.bundle.patch
  cordis.patch.yml        # 插入插件 + 默认 config
  restore.mjs             # 恢复 CLI
  test\
    purge.test.mjs        # node:test 单元测试（建议）
```

`package.json` 参考：

```json
{
  "name": "dsh-session-purge",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

`index.js` 建议导出一些纯函数给测试：

```js
export { normalizeConfig, resolveSessionDir, planMoves, moveOne, purgeTrash, restoreEntry };
```

注意：导出内部函数不影响 DSH 插件加载；`name` 和 `apply` 仍在。

---

## 8. 实施步骤（按顺序）

### Step 1：脚手架

- 创建 `index.js`、`package.json`、`cordis.patch.yml`、`restore.mjs`。
- 确认 `package.json` 的 `type: module`、`exports`、`dsh.bundle.patch`。
- 不装依赖。

### Step 2：基础工具

实现：

- `resolveDshHome(config)`
- `normalizeConfig(config, home)`
- `formatBytes`
- `createLogger(ctx, file)`
- `withLock(lockPath, staleMs, fn)`
- `readJson` / `writeJsonAtomic`
- `readdirSafe`

### Step 3：guard 收集

实现 `collectProtected(ctx, config)`：

- `workspaceRegistry.pinnedSessionIds`
- `sessions.list()`
- `schedule.catalog()`；失败回退 `schedule.json`；两者都失败 → throw
- 返回 `Set<id>`

实现 `loadSnapshots(ctx)`：

- `ctx.sessionPersistence.list()`
- 失败时返回 `null`，移动阶段跳过，回收站清理继续

### Step 4：路径校验

实现 `resolveSessionDir(config, snapshot)`，严格按 5.6。建议先写测试，覆盖：

- 正常路径
- id 格式错
- artifact 名字错
- 目录名 ≠ id
- 路径逃逸 `..`
- 符号链接
- 多一层/少一层目录

### Step 5：计划（纯函数优先）

实现 `planMoves({ config, now, snapshots, archived, protectedIds })`：

- 过滤 archived / protected / 无 location / 路径不安全 / mtime 不够
- 建 `entries`、`byParent`
- 家族过滤（两轮：先全量，再 limit 后）
- 按 depth 降序、mtime 升序排序
- 返回 `{ candidates, skipped, entries }`

`planMoves` 不碰文件系统写操作，只 `stat`；方便测试。

### Step 6：移动到回收站

实现 `moveOne(ctx, config, candidate)`：

- 二次 guard
- 生成 entry 名（UTC 紧凑时间 + session id）
- `mkdir(entryDir)`
- 写 `meta.json` `state:"moving"`
- `rename(sessionDir, entryDir/session)`；EXDEV 回退 `cp` + `rm`
- 移投影缓存（可选，失败不阻塞）
- 重写 `meta.json` `state:"complete"`
- 失败清理空 entry（仅当 session 未移入）
- 返回 `{ moved:true, bytes, entryName }`

### Step 7：回收站清理

实现 `purgeTrash(config, now)`：

- 扫描 `trashRoot` 的直接子目录
- 读 meta；缺失用目录 mtime
- 满 `trashRetentionDays` → `rm`
- 返回 `{ purged, bytes, skipped }`

### Step 8：单轮编排

实现 `runOnce(ctx, config)`：

1. 拿锁
2. 先 `purgeTrash`
3. 再 `loadSnapshots` + `collectProtected` + `planMoves`
4. 逐候选 `moveOne`
5. 写 state / 日志摘要
6. 释放锁

`dryRun` 时：

- `purgeTrash` 只报告，不 `rm`
- `moveOne` 只报告，不 `mkdir`/`rename`
- 不写回收站、不改原文件
- 仍然写 state 的 `lastRun`（方便看报告）

### Step 9：恢复 CLI

`restore.mjs`：

```powershell
node restore.mjs --list
node restore.mjs --session session-209ac311-fe6f-4bc4-bdfc-bfa8bbbe8a27
node restore.mjs --entry 20261113T014500123Z__session-209ac311-fe6f-4bc4-bdfc-bfa8bbbe8a27
```

- 用同一把锁
- 校验 meta / 原路径 / 目标不存在
- 移回 `session/` 和 `projection-cache.json`
- 删除 entry
- 输出“restart dsh web”

### Step 10：测试

先跑单元测试，再对真实 `~/.dsh` 跑 dry-run。

### Step 11：安装

见第 10 节。

---

## 9. 测试与验收

### 9.1 单元测试（临时目录，不碰真实数据）

用 `node:test` + `mkdtemp`。建议用例：

| 用例 | 断言 |
|---|---|
| 正常移动 | 原 session 目录消失；entry 有 `meta.json`、`session/session.v4.jsonl.zstd`；cache 在 entry |
| dryRun | 原目录、cache、trash 都不变；报告里有 would-move |
| mtime 不够 | 不移动；skipped reason `not-eligible` |
| mtime 够但未归档 | 不移动 |
| live/pinned/scheduled | 不移动；reason `protected` |
| 家族：父老、子新 | 父子都不移动 |
| 家族：父子都老 | 都移动；子 entry 先创建（depth 降序） |
| 路径逃逸 | skip；不删任何东西 |
| 符号链接 | skip |
| 回收站 6 天 | 保留 |
| 回收站 8 天 | 删除 |
| meta 缺失但目录 8 天 | 删除并 warn |
| state=moving 8 天 | 删除并 warn |
| 恢复 | 原目录/cache 回位；entry 消失 |
| 恢复目标已存在 | abort，不覆盖 |
| guard 失败 | 不移动；trash 仍可清理 |
| 锁被占 | 本轮 skip |

### 9.2 真实数据 dry-run

安装后第一次：

```powershell
Get-Content C:\Users\win10\.dsh\logs\session-purge.log -Tail 50
```

预期（2026-11-13）：

```text
run scanned=182 archived=86 eligible=0 moved=0 purged=0 errors=0 dryRun=true
```

- `eligible=0` 正确：48 个归档会话 mtime 最大 24.9 天。
- 不要为了看效果改 `archiveRetentionDays: 0` 跑真实数据；用临时 fixture。
- 确认 `~/.dsh/sessions` 目录数仍为 182，`~/.dsh/session-purge/trash` 为空。

### 9.3 模拟“满 30 天”的端到端

用临时 `DSH_HOME`（例如 `C:\Users\win10\AppData\Local\Temp\purge-test`）：

1. 建 `sessions\--test--\session-<uuid>\session.v4.jsonl.zstd`，内容随便。
2. 建 `storages\session_projcache\sessions\session-<uuid>.json`。
3. 建 `storages\workspace.json`，`global.archivedSessionIds` 含该 id。
4. 把 session 文件 mtime 设为 40 天前。
5. 用测试 harness 直接调 `planMoves` / `moveOne` / `purgeTrash`（不要启动真实 DSH）。
6. 断言：entry 出现、原目录消失、meta 正确；把 meta `movedAt` 改成 8 天前，跑 `purgeTrash`，entry 消失。

### 9.4 验收标准

- [ ] 真实 dry-run 不产生任何文件变化（sessions 数量、trash 为空、cache 不变）。
- [ ] 归档 + mtime ≥30 天的会话被移入 trash，而不是删除。
- [ ] trash 条目 <7 天保留，≥7 天彻底删除。
- [ ] live / pinned / active-or-paused schedule 的会话绝不移动。
- [ ] 父子会话不会被拆散（要么都移，要么都不移）。
- [ ] 路径逃逸/符号链接被拒绝。
- [ ] `workspace.json`、`attachments`、`sessions-archive`、`fast-search.db` 未被修改。
- [ ] `restore.mjs` 能把会话和 cache 移回；重启后 DSH 能看到。
- [ ] 日志和 state.json 可读；错误不会导致下一轮不跑。
- [ ] 锁生效；并发运行不会双移。

---

## 10. 安装（在普通终端跑，不要在受限沙箱里跑）

> 当前来源会话的文件策略是 `danger-full-access`；新会话如果又是 `workspace-write`，写 `C:\Users\win10\.dsh` 会 `EPERM`。安装命令请在普通 PowerShell 里跑，或批准一次 full access。

```powershell
# 1) 确认 dsh 在 PATH
Get-Command dsh | Select-Object Source

# 2) 让 web profile 解析到本地插件
dsh plugin --profile web add link:C:/data/projects/dsh-session-purge

# 如果 pnpm 不认 link:，用：
# dsh plugin --profile web add C:/data/projects/dsh-session-purge

# 3) 加入 profile bundles（dsh plugin add 不会自动加）
$pkgPath = "C:\Users\win10\.dsh\profiles\web\package.json"
$pkg = Get-Content -LiteralPath $pkgPath -Raw | ConvertFrom-Json
if ($pkg.dsh.profile.bundles -notcontains 'dsh-session-purge') {
  $pkg.dsh.profile.bundles += 'dsh-session-purge'
}
$pkg | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $pkgPath -Encoding UTF8

# 4) 确认配置能解析
dsh --profile web --dump-config | Select-String -Pattern 'session-purge' -Context 2,8

# 5) 重启 dsh web（用现有的 watcher / WMI 触发）

# 6) 看日志
Get-Content C:\Users\win10\.dsh\logs\session-purge.log -Tail 50
```

第一次保持 `dryRun: true`。确认报告后，把 `cordis.patch.yml` 的 `dryRun` 改成 `false`，重启。

### 卸载

```powershell
# 从 bundles 移除，然后
dsh plugin --profile web remove dsh-session-purge
# 删除 node_modules 下的链接/副本（如果还在）
# 插件数据保留在 C:\Users\win10\.dsh\session-purge，确认后再手工删
```

---

## 11. 风险、边界、已知问题

1. **运行中缓存**：移动后，当前 DSH 进程的 `sessionPaths` / 前端列表缓存可能仍显示旧归档条目，直到重启。重启前不要点开/取消归档这些会话；重启后消失。
2. **取消归档的窗口**：如果用户在移动后、重启前对某 id 调 `unarchiveSession`，DSH 会认为它还在归档集合里可操作，但文件已在回收站。v1 不拦截（没有公开 hook）；文档/日志提示“移动后重启”。
3. **mtime 语义**：是“最后写入超过 30 天”，不是“归档超过 30 天”。一个 60 天前创建、昨天归档、但文件 40 天没写的会话会被移动；一个昨天还在写的旧会话不会。用户已明确选择 mtime。
4. **mtime 被重写**：DSH 格式迁移/修复可能更新 mtime，导致延迟移动；不会提前。
5. **家族保守**：家族里有一个不满足条件，整族保留；可能让老会话多等。安全优先。
6. **部分家族移动**：运行时某个子会话移动失败，父会话会被跳过；下一轮重试。若极端情况下部分成员已移入 trash，恢复要按条目逐个恢复。
7. **跨卷**：trashRoot 与 sessions 不同盘时，`rename` 失败，回退 `cp` + `rm`，不是原子操作；崩溃可能留下半拷贝。建议同卷。
8. **Windows 占用**：`EBUSY/EPERM` 跳过，下一轮重试；不强制结束进程。
9. **投影缓存占用**：移动失败时保留原缓存，meta 标记 false；重启后 DSH 可重建；恢复时若缓存已在原处，不覆盖。
10. **38 个无 live 文件的归档 id**：它们在 `sessions-archive\2026-11-07-empty` 有副本；本插件只扫 `~/.dsh/sessions`，不会处理。要清那个目录需另写工具/手工。
11. **fast-search.db**：删/移会话文件后，fast-search watcher 会移除索引行，但 db 文件不会缩小；293 MB 要缩需停 DSH 后 `VACUUM`，本插件不做。
12. **workspace.json 残留**：归档 id 仍在，重启后 DSH 过滤缺失 header；不要手工改。
13. **半成品条目**：`state:"moving"` 或 meta 缺失的条目，满 7 天会删；如果希望更保守（例如保留 30 天），需要改 `purgeTrash` 的 fallback 规则。
14. **恢复后**：必须重启 DSH；`restore.mjs` 不会热加载。
15. **权限**：插件运行在 DSH 宿主用户下，需要对 `~/.dsh/sessions`、`~/.dsh/storages/session_projcache`、`~/.dsh/session-purge` 有读写/改名权限。

---

## 12. 待确认（默认按“已定”实施，用户另说再改）

| 问题 | 默认 |
|---|---|
| 回收站路径 | `C:\Users\win10\.dsh\session-purge\trash`；如果你说的“角色目录”是指 DSH workspace 角色，请明确，默认只做文件系统目录、不注册 workspace |
| 每日是“24 小时一次”还是“固定 03:00” | 24 小时一次，从启动后 60 秒首跑开始 |
| 恢复是否需要 UI/HTTP | v1 只做 `restore.mjs` CLI |
| 半成品/无 meta 条目是否 7 天也删 | 是，日志 warn |
| 38 个 `sessions-archive` 副本 | 不处理 |
| `fast-search.db` VACUUM | 不做 |
| 回收站是否注册为 DSH workspace | 不注册 |

如果用户没有新的相反指示，新会话按这些默认直接实施。

---

## 13. 参考资料（新会话可直接查）

### 13.1 关键源码/文档位置

- 核心包：
  `C:\Users\win10\AppData\Local\Author Software\nvm\installs\v26.10.0\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`
- `dsh-session-persistence` 类型：
  `...\@deepseek-ai\dsh-session-persistence\lib\types\index.d.ts`
- `dsh-session-persistence-jsonl` README：
  `...\@deepseek-ai\dsh-session-persistence-jsonl\README.zh.md`（第 167 行：无删除接口）
- `dsh-workspace` README：
  `...\@deepseek-ai\dsh-workspace\README.zh.md`（第 118、169 行）
- `dsh-workspace/lib/index.js`：
  `get sessionIds()` L102；`candidateMatches` L362-372
- `dsh-client-ui-workspace/lib/client.js`：
  `reconcileManualOrder`、`sessionVisible`、渲染 L1151
- 第三方插件样板：
  `C:\Users\win10\.dsh\profiles\web\node_modules\dsh-fast-search\index.js`
  `...\dsh-active-sessions\index.js`

### 13.2 API 速查

```ts
ctx.sessionPersistence.list(): Promise<SessionPersistenceSnapshot[]>
ctx.workspaceRegistry.archivedSessionIds: readonly SessionId[]
ctx.workspaceRegistry.pinnedSessionIds: readonly SessionId[]
ctx.workspaceRegistry.archiveSession(id, { stopActivity? })
ctx.workspaceRegistry.unarchiveSession(id)
ctx.sessions.list(): Session[]
ctx.sessions.get(id): Session | undefined
ctx.schedule.catalog(): Promise<ScheduleCatalogEntry[]>
ctx.interval(callback, delay): () => void
ctx.timeout(callback, delay)
```

`ScheduleCatalogEntry` 关键字段：

```ts
{
  target: { kind: 'session', sessionId } | { kind: 'new_once', sessionId, ... } | { kind: 'new', create },
  involvedSessionIds: string[],
  status: 'active' | 'paused' | 'ended',
  executionActive?: boolean
}
```

### 13.3 插件加载样板

```js
export const name = 'dsh-session-purge';
export async function apply(ctx, config = {}) {
  ctx.effect(() => {
    // 启动任务 + 定时器
    return () => { /* 清理 */ };
  });
  // 可选：ctx.inject(['webServer'], scoped => { ... })
}
```

`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`；profile 的 `dsh.profile.bundles` 加入包名后，DSH 会应用包内 patch。

---

## 14. 交接清单（新会话开工前逐项确认）

- [ ] 已读本文件第 1–6 节，理解“mtime / 每日 / 回收站 7 天”三个决策。
- [ ] 确认 `C:\data\projects\dsh-session-purge` 为空或只有本文件。
- [ ] 确认当前会话文件策略能写 `C:\Users\win10\.dsh`（否则安装命令交给用户终端）。
- [ ] 先实现纯函数 + 单元测试，不碰真实 `~/.dsh`。
- [ ] 真实 dry-run 预期 `eligible=0`（2026-11-13 数据），不要误以为失败。
- [ ] 真实数据只跑 dry-run；移动/删除只在临时 fixture 验证。
- [ ] 安装前把 `dryRun: true` 写进 `cordis.patch.yml`。
- [ ] 安装后重启 DSH，检查日志、state、trash 为空。
- [ ] 把实施结果、测试结果、安装命令回报给用户；用户确认后再开 `dryRun: false`。

---

## 15. 给新会话的第一条建议回复

> 我已读 `HANDOFF.md`。先按 mtime + 每日 + 回收站 7 天的设计实现，默认 dry-run。第一步写 `index.js` 的路径校验和 `planMoves` 纯函数 + 单元测试，再写 `moveOne` / `purgeTrash` / `restore.mjs`，最后安装并跑真实 dry-run（预期 eligible=0）。

---

## 16. 实施记录（2026-11-13，本机已落地）

### 16.1 交付物（`C:\data\projects\dsh-session-purge`）

| 文件 | 说明 |
|---|---|
| `index.js` | 插件本体，零依赖 ESM（只用 Node 内建模块）。`apply` 基于 `ctx.effect` + `setTimeout`/`setInterval` + `unref()`——cordis 没有 `ctx.interval`/`ctx.timeout`。 |
| `restore.mjs` | 恢复 CLI：`--list` / `--session` / `--entry` / `--dry-run` / `--dsh-home` / `--trash-root` / `--json`。退出码 0=成功、1=失败、2=用法错误、3=锁被占用。 |
| `cordis.patch.yml` | 插入 `{ id: session-purge, name: dsh-session-purge }`，`dryRun: true`，13 个配置键 + 显式绝对路径。 |
| `test/purge.test.mjs` | 35 个 `node:test` 用例，全部在 `mkdtemp` 临时 home 内。 |
| `scripts/real-dry-run.mjs` | 对真实 `~/.dsh` 的只读预演（不启宿主、不写文件，前后 fingerprint 对比自证）。 |
| `README.md` | 使用说明；安装命令按本机实际可行方式写（`file:`）。 |

导出面：`name`、`version`、`apply`，以及可测试的纯函数与内部步骤（`normalizeConfig` / `validateConfig` / `resolveSessionDir` / `planMoves` / `moveOne` / `purgeTrash` / `runOnce` / `restoreEntry` / `acquireLock` / `withLock` 等）。**不导出 `Config`**，与 `dsh-fast-search` 一致（profile 的 `node_modules` 根没有 schemastery，导出 schema 反而会加载失败）。

### 16.2 测试

`node --test test/` → **35 tests, 34 pass, 1 skipped, 0 fail**（约 10 s）。

唯一 skip 的是符号链接/junction 用例：本机进程无法创建 reparse point（`fs.symlink` 报 EPERM，`mklink /J`、`New-Item -ItemType Junction` 报 Access denied）。代码里的 `lstat` 守卫仍然生效，只是没法在测试里造出敌人的链接。

### 16.3 真实只读预演（2026-11-13）

`node scripts/real-dry-run.mjs`：

```text
scanned=183  archived=86  pinned=2  scheduled=1  eligible=0
reasons: not-eligible=48  no-snapshot=38
归档文件最大年龄 25.0 天；回收站为空；sessions 183→183；workspace.json 未变
```

`eligible=0` 与 §9 的预期一致（最老 25.0 天 < 30 天）。

### 16.4 安装（web profile）——与 §10 的偏差

- `dsh plugin --profile web add link:...` **失败**：`ERR_PNPM_PACKAGE_MANAGER_SYMLINK_FAILED ... Access is denied (os error 5)`。本环境禁止建符号链接；pnpm 已自动回滚 `package.json`。
- 改用 **`dsh plugin --profile web add file:C:/data/projects/dsh-session-purge`** 成功：pnpm 以**硬链接**方式放入 `node_modules/dsh-session-purge`（真实目录，`index.js` nlink=2），`dependencies` 记录为 `"dsh-session-purge": "file:C:/data/projects/dsh-session-purge"`。
- **`dsh plugin add` 会自动把包名追加进 `dsh.profile.bundles`**（§10 说「不会自动加」在这版不成立），本次没有手工改 profile。
- 安装前备份（同在 `C:\Users\win10\.dsh\profiles\web\`）：`package.json.bak-session-purge-20261113-021305`、`cordis.patch.yml.bak-session-purge-20261113-021305`。
- `dsh --profile web --dump-config` 已出现 `# == dsh-session-purge` 层，`id: session-purge`，`dryRun: true`，配置齐全。
- **硬链接注意**：整文件替换源码后要重新 `add` 一次，否则安装副本不跟随源码。

### 16.5 宿主内实跑（2026-11-13 18:14 +08:00，用户重启宿主后）

插件已装配并跑完第一轮（`dryRun: true`）：

```text
[10:14:02Z] [info] 启动：dryRun=true archiveRetentionDays=30 trashRetentionDays=7 intervalMinutes=1440 startupDelayMs=60000 sessionsRoot=... trashRoot=...
[10:15:02Z] [debug] skip ...（86 条明细，只写日志文件）
[10:15:02Z] [info] run scanned=183 archived=86 eligible=0 moved=0 purged=0 errors=0 dryRun=true
[10:15:02Z] [info] skips not-eligible=48 no-snapshot=38
```

`state.json`：`runsTotal=1`、`lastRun.durationMs=604`、`wouldMove=0`、`wouldPurge=0`，回收站为空。启动延迟 60 s 与装配流程均按设计生效。

### 16.6 切换到真实模式（2026-11-16，用户确认后）

- `cordis.patch.yml` 的 `dryRun` 已由 `true` 改为 `false`，并重新执行 `dsh plugin --profile web add file:...` 同步进 profile。
- `dsh --profile web --dump-config` 确认 `# == dsh-session-purge` 层里 `dryRun: false`。
- **需重启 `dsh web` 才生效**：正在跑的宿主进程内存里仍是 `dryRun: true`。本会话未代做重启。
- 切换前的 10 轮 dry-run 记录：全部 `errors=0`、`eligible=0`，回收站为空，无锁残留。
- 投影缓存命名已核对：`~/.dsh/storages/session_projcache/sessions/<sessionId>.json`，首批候选 3 条均有缓存（6.4～8.8 KB），移动时会一起进回收站。

### 16.7 尚未完成

1. 真实数据上的第一次移动预计在 **2026-11-18 下午**：届时有 7 条归档会话越过 30 天（当时最老 27.9 天）。
2. 真实的移动/删除目前只在 `mkdtemp` fixture 里验证过（`runOnce` / `purgeTrash` / `restoreEntry` 用例）；首次真实移动后应核对回收站 `meta.json` 与旧路径是否都符合预期。
3. 移动后到宿主重启前，前端会话列表可能仍显示旧条目（运行中缓存），属已知行为。
