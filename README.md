# dsh-session-purge

DSH 插件：把**归档且长期没写过**的会话先移进独立回收站，再把回收站里放满 7 天的条目彻底删除。

两段式，保留期分开：

| 阶段 | 条件 | 动作 |
|---|---|---|
| 归档移动 | 会话在 `workspace.json` 的归档集合里，且 `session.v4.jsonl.zstd` 的 mtime ≥ `archiveRetentionDays`（默认 **30 天**） | 整个 `session-<uuid>` 目录 + 投影缓存 **移动**到 `~/.dsh/session-purge/trash/<UTC时间戳>__<sessionId>/` |
| 回收站清理 | 条目从 `movedAt` 起 ≥ `trashRetentionDays`（默认 **7 天**） | 物理删除整个条目目录 |

从不直接 `rm` 会话：任何删除都必须先经过回收站。默认 `dryRun: true`，第一次运行只写日志和 `state.json`。

## 为什么是 mtime

DSH 的归档只写 `global.archivedSessionIds`（字符串数组），**没有 `archivedAt`**；`SessionHeader` 也只有 `createdAt`。因此「归档满 30 天」无法计算。这里用「会话文件的最后写入时间」作为闲置口径——用户已明确选择这个语义：

- 文件 40 天没写、昨天才归档的会话 **会**被移动；
- 昨天还在写、归档很久的会话 **不会**。

mtime 被 DSH 的格式迁移/修复重写时，会话只会「变年轻」、延后移动，不会提前。

## 安装

```powershell
# 从 GitHub Release 安装；dsh plugin add 会自动把包名加进 dsh.profile.bundles
dsh plugin --profile web add https://github.com/zp96324511/dsh-session-purge/releases/latest/download/dsh-session-purge.tgz

# 重启 dsh web（插件只在宿主启动时装配），60 秒后跑第一轮
```

升级要用**带版本号**的 URL——`latest/download` 的 specifier 不变，pnpm 会跳过重新解析：

```powershell
dsh plugin --profile web add https://github.com/zp96324511/dsh-session-purge/releases/download/v0.1.1/dsh-session-purge.tgz
```

包自带的 `cordis.patch.yml` 只给安全缺省（`dryRun: true`，路径按 `$DSH_HOME` 推导）。要开真实模式或改路径，**不要改包里那份**（升级会被覆盖），在 profile 的 `cordis.patch.yml` 里按 id 覆盖——config 是整体替换、不深合并，字段要写全：

```yaml
- id: session-purge
  config:
    enabled: true
    dryRun: false
    trashRoot: 'D:\dsh-trash'
    # 其余键省略即用默认值
```

重启后 60 秒跑第一轮，之后每 24 小时一轮。先看日志：

```powershell
Get-Content $env:USERPROFILE\.dsh\logs\session-purge.log -Tail 50
```

确认 `eligible` 数目符合预期、再打开 `dryRun: false`。

### 本地开发

```powershell
cd path\to\dsh-session-purge
node --test "test/**/*.test.mjs"
# 本机禁止建符号链接时用 file:（pnpm 以硬链接放入 node_modules）；改完源码要重新 add
dsh plugin --profile web add file:C:/path/to/dsh-session-purge
```

> 同一个 profile 里 GitHub 版与 `file:` 版只能装一个，后装的覆盖前者。

卸载：

```powershell
dsh plugin --profile web remove dsh-session-purge
# 插件数据保留在 ~/.dsh/session-purge；确认不需要后再手工删
```

## 配置

`cordis.patch.yml` 的 `config`（全部可选，缺省见「默认」列）：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉插件但不卸载（不调度任何运行） |
| `dryRun` | `true` | 只报告：不建目录、不改名、不删除，仍写 `state.json` |
| `archiveRetentionDays` | `30` | 会话文件 mtime 超过多少天可移入回收站 |
| `trashRetentionDays` | `7` | 回收站条目满多少天彻底删除 |
| `intervalMinutes` | `1440` | 每日一次；从首跑开始计时（不是固定钟点） |
| `startupDelayMs` | `60000` | 启动后延迟，避开宿主启动 I/O |
| `maxMovesPerRun` | `50` | 单轮最多移动多少会话（家族不会被切一半） |
| `maxTrashPurgesPerRun` | `100` | 单轮最多彻底删除多少条目 |
| `moveProjectionCache` | `true` | 是否把投影缓存一起移入回收站 |
| `sessionsRoot` | `$DSH_HOME/sessions` | 会话根 |
| `projectionCacheDir` | `$DSH_HOME/storages/session_projcache/sessions` | 投影缓存目录 |
| `trashRoot` | `$DSH_HOME/session-purge/trash` | 回收站根；**不能**放在 sessions 下面 |
| `statePath` | `$DSH_HOME/session-purge/state.json` | 状态与锁路径 |
| `logFile` | `$DSH_HOME/logs/session-purge.log` | 日志 |
| `lockStaleMs` | `600000` | 锁超过 10 分钟视为残留 |

`$DSH_HOME` 缺省是 `~/.dsh`；配置里的绝对路径优先。`trashRoot` 落在 `sessionsRoot` 里面时插件拒绝启动（DSH 会把回收站当成会话目录扫描）。

## 回收站布局

```text
%USERPROFILE%\.dsh\session-purge\
  state.json                  # 最近运行 + 累计统计（不是正确性来源）
  state.json.lock             # 单飞锁（restore.mjs 共用）
  trash\
    20261113T014500123Z__session-209ac311-fe6f-4bc4-bdfc-bfa8bbbe8a27\
      meta.json               # moving → complete
      session\                # 原 session-<uuid> 目录整体移入
      projection-cache.json   # 原投影缓存（存在才移）
```

`meta.json` 关键字段：`state`（`moving`/`complete`）、`sessionId`、`originalSessionDir`、`originalArtifact`、`originalProjectionCache`（不存在为 `null`）、`artifactMtime`、`sizeBytes`、`movedAt`、`purgeAfter`、`projectionCacheMoved`、`pluginVersion`。

条目名里的 UTC 时间戳让「按时间清理」不必读 meta；同名冲突也就不可能发生。

## 恢复

```powershell
# restore.mjs 随包安装；源码目录里是同一份
$plugin = "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-session-purge"
node "$plugin\restore.mjs" --list
node "$plugin\restore.mjs" --session session-209ac311-fe6f-4bc4-bdfc-bfa8bbbe8a27
node "$plugin\restore.mjs" --entry 20261113T014500123Z__session-209ac311-...
node "$plugin\restore.mjs" --session <id> --dry-run
```

- 恢复只做「文件回位」，**不改 `workspace.json`**：该 id 本来还在归档集合里，文件回来后重启 DSH 就会重新出现在归档视图。
- 目标目录已存在时**拒绝覆盖**，先人工确认。
- 同一会话有多个回收站条目时，`--session` 会报错并要求用 `--entry` 精确指定。
- 恢复后**必须重启 `dsh web`**，运行中的进程不会热加载。
- 与插件共用 `state.json.lock`，不会和正在跑的一轮互相踩。

## 安全闸

一个会话要被移动，全部条件都必须满足：

1. 在 `workspaceRegistry.archivedSessionIds` 里；
2. 不是进程内活会话（`ctx.sessions.list()`），不在 `pinnedSessionIds`；
3. 不是 `active`/`paused` 定时任务的 `target.sessionId`，也不在它们的 `involvedSessionIds`；
4. 会话文件存在且 `now - mtime >= archiveRetentionDays`；
5. 路径校验：id 匹配 `session-<uuid>`、文件名匹配 `session.vN.jsonl[.zstd]`、目录名等于 id、相对 `sessionsRoot` 恰好 3 段、workspace 目录/会话目录/会话文件都不是符号链接或 junction；
6. 家族校验：`parentSession` 组成的家族里任一方不满足条件，整族本轮都不动；移动顺序先子后父，父会话移动前会再次确认子会话都成功了。

任一 guard 数据源失败（`sessionPersistence.list()`、`workspaceRegistry`、`sessions`、`schedule.catalog()` 与 `schedule.json` 都读不到）→ **跳过移动阶段**，一个会话都不碰；回收站清理照常进行。

`workspace.json` 的归档 id 保持不动（只是字符串，体积可忽略）；DSH 重启后按「缺失 header」自动过滤。

## 日志与状态

```text
[2026-11-13T...] [info] run scanned=182 archived=86 eligible=0 moved=0 purged=0 errors=0 dryRun=true
[2026-11-13T...] [info] skips not-eligible=48 no-snapshot=38
[2026-11-13T...] [info] would-move session-... -> trash/20261113T...__session-... (19.4 KB, ageDays=30.1)
```

- 每次跳过的明细（`skip <id> reason=... ageDays=...`）只写进日志文件的 `[debug]` 行，不镜像到宿主控制台，避免每天几十行噪声。
- `state.json` 里 `lastRun` 是本轮摘要，`stats` 是累计值；它损坏时删掉即可，正确性只依赖回收站里的 `meta.json`。

## 只读预演

不启动宿主、不写任何文件，直接对真实 `~/.dsh` 算一遍：

```powershell
node "$plugin\scripts\real-dry-run.mjs"          # $plugin 见上（恢复一节）
node "$plugin\scripts\real-dry-run.mjs" --json
```

它自己扫 `sessions/`、解压每个会话日志的第一行取 header、读 `workspace.json` / `schedule.json`，然后调用插件里同一个 `planMoves()`。2026-11-13 的实测输出：扫描 183、归档 86（48 个有 live 文件共 11.6 MB，38 个只在 `sessions-archive` 有副本）、满足条件 **0**（最老 25.0 天）、回收站为空。`eligible=0` 是正确结果，不是失败。

## 测试

```powershell
cd path\to\dsh-session-purge
node --test "test/**/*.test.mjs"
```

35 个用例，全程在 `mkdtemp` 的临时 home 里跑，不碰真实数据：路径逃逸/深度/符号链接、家族父子保护与截断、30/7 天两条保留期、dry-run 无副作用、guard 失败仍清回收站、锁与 stale 锁、恢复与拒绝覆盖。

符号链接用例在不能创建 junction 的环境里会 skip（需要 Developer Mode 或管理员权限）。

## 已知限制

1. **运行中缓存**：移动后当前 DSH 进程的 `sessionPaths`／前端列表可能仍显示旧条目，重启后才消失。重启前别点开/取消归档这些会话。
2. **取消归档的窗口**：移动后、重启前若对某 id 调用 `unarchiveSession`，文件已在回收站。v1 不拦截（没有公开 hook），日志会提示「移动后重启」。
3. **跨卷**：`trashRoot` 与 `sessions` 不同盘时 `rename` 失败，回退 `cp` + `rm`，不是原子操作（会先校验再删源，失败时删副本、不动源）。建议同卷。
4. **Windows 占用**：`EBUSY/EPERM` 跳过，下一轮重试；不强制结束进程。投影缓存被占用时留在原地，meta 记 `projectionCacheMoved: false`，重启后 DSH 可重建。
5. **家族保守**：家族里有一个成员不满足条件，整族保留；可能让老会话多等几天。安全优先。
6. **38 个「只在 `sessions-archive` 有副本」的归档 id**：不在 `sessions/` 下，没有 mtime 可算，插件不处理（`reason=no-snapshot`）。
7. **`fast-search.db`**：删除会话文件后由 fast-search 自己的 watcher 清索引行，db 文件不会缩小；需要缩容要停 DSH 后 `VACUUM`，本插件不做。
8. **不做在线 SQLite 操作、不动 `attachments`、不注册回收站为 workspace、不自动恢复**。

## 发布新版本

改版本号、提交、打 tag，剩下的交给 workflow：

```powershell
npm version patch --no-git-tag-version    # 或 minor / major
git commit -am "chore: release v0.1.1"
git push
git tag -a v0.1.1 -m "v0.1.1"
git push origin v0.1.1
```

`.github/workflows/publish.yml` 会校验 tag 与 `package.json` 版本一致、跑测试、打包，然后创建 release，附带
`dsh-session-purge.tgz`（稳定文件名，供 `releases/latest/download` 用）、`dsh-session-purge-<ver>.tgz`、
`channel.json` 与 `.sha256`。CI（`ci.yml`）在 ubuntu 与 windows 上跑同一套测试，并把打包产物装进临时目录
`import` 一次，确保 `files` 没漏东西。

## 文件

```text
index.js                 # 插件本体（零依赖 ESM）：配置、路径校验、计划、移动、清理、恢复、调度
restore.mjs              # 恢复 CLI
cordis.patch.yml         # 插入插件 + 默认 config（dryRun: true）
scripts/real-dry-run.mjs # 对真实 home 的只读预演
test/purge.test.mjs      # node:test 单元测试
HANDOFF.md               # 设计与验收口径（档源）
```
