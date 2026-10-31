# 行为资产对照表（test-matrix）

> 目的：把 tide-cap-master 的 docs/03、08、09 里**用真机踩坑换来的教训**逐条落到
> 「一条自动化回归测试」或「一条可复现的人工验收步骤」上。
>
> 为什么需要这张表：重构的最大风险不是写不出代码，而是**规范搬迁走样**——
> 断流两层重连、cap 切点落段边界、重合并不毁产物、恢复扫描的孤儿判定，
> 这些行为在文档里是"一句话"，在代码里是一堆时序细节，只能靠测试钉住。
>
> 状态：**2026-10-30，M1–M5 全部自动化项已落地并通过（127 条）**。
> 真机项（需要真实平台/设备）列在 §6，未打勾的属于交付前必须补的一次性验收。

运行方式：

```bash
pnpm test                 # 全部（vitest，15 个文件 / 127 条）
pnpm lint && pnpm typecheck
cd plugins/streamget-plugin && PYTHONPATH=site-packages python3 -m unittest discover -s tests -v   # 40 条
```

---

## 1. M1 录制引擎

| # | 教训（出处） | 落点 |
|---|---|---|
| I1 | 断流**不能**当"下播"：只有 resolve 确认不在播才算 offline（docs/03 §3） | `core/engine.test.ts` › 退出非 0 但已落段 → 以 offline 收尾 |
| I2 | 重连分两层：ffmpeg 原地重连（参数里 `-reconnect_streamed`）与应用层重连（重新解析 + 退避） | `core/ffmpeg.test.ts` › 布尔选项一律显式给值 ＋ `core/engine.test.ts` › 异常退出后续录 |
| I3 | 连续 5 次拉起就死必须放弃（`FAIL_STREAK_LIMIT`），否则热循环 | `core/classify.test.ts` › 退避阶梯 ＋ `core/engine.test.ts` › 卡死看门狗 |
| I4 | 缺口要如实记账（`gaps[]` + `recording.gap` 事件），不许拿"段时长之和"反推 | `core/engine.test.ts` › 缺口如实记账（含 `after_part`） |
| I5 | 卡死看门狗：启动宽限后连续 20s 零增长 → **硬杀**（卡住的进程不读 stdin） | `core/engine.test.ts` › 卡死看门狗（断言 `killed=true` / `stopped=false`） |
| — | 段号跨连接必须来自文件名：seglist 会累积，按 entries 下标推会跳号 | `core/engine.test.ts` › 段号不重复（1/2/3）＋ `core/ffmpeg.test.ts` › 文件名里的段号 |
| — | `-headers` 必须在 `-i` 之前，且空头平台命令行逐字节不变 | `core/ffmpeg.test.ts` › 请求头出现在 -i 之前 / 空头不产生 -headers |
| — | `-progress` 认 `out_time_us`（微秒），`N/A` 是"还没有值" | `core/ffmpeg.test.ts` › progress 认 out_time_us |
| — | stderr 分类决定处置：磁盘不重试、403 是 URL 过期、reset 是 CDN | `core/classify.test.ts` › 8 条规则 + 优先级 |
| — | `retryable=false` ≠ "这一场到此为止"（只有 auth/dep/unsupported 才结束） | `core/classify.test.ts` › retryable=false 不等于到此为止 |
| — | 手动"停这一场"在监控开着时要落 `skip_current_live`（否则下一轮又开录） | `core/engine.test.ts` › 手动停止 → skip_current_live / snoozed |
| — | 单场上限到点：优雅收尾 → 自动后处理 → 开新场 `origin=cap`，**不**清 `record_requested` | `core/engine.test.ts` › 体积到上限 → capped + 新场 cap |
| — | 磁盘写满：停新分段、明确报"磁盘"，不继续重试 | `core/engine.test.ts` › 磁盘写满 → end_reason=disk（只拉一次 ffmpeg） |
| — | **宿主退出必须走同一条收尾**，且 `reason=shutdown` 时跳过自动后处理 | `core/engine.test.ts` › 宿主退出（reason/manifest 双断言） |
| — | 缺 ffmpeg 这类环境问题要报 `needs_dep`，不能表现为"重连 unknown" | `core/engine.test.ts` › 缺 ffmpeg → needs_dep（且不 spawn） |

## 2. M2 后处理与恢复

| # | 教训（出处） | 落点 |
|---|---|---|
| I6 | 产物先写 `.tmp-`，校验全过才 rename —— **重合并失败不许毁掉已有产物** | `core/postprocess.test.ts` › 合并失败：正式产物 999 字节不动 + `.failed.mp4` |
| — | 同构分组：连续段同 layout 合并；参数变化切组并按分辨率后缀区分 | `core/merge.test.ts` › 参数变化切组 |
| — | `normalize` 是**组级**决策：一处脏 → 整组重封装（只修脏段必造混源组） | `core/merge.test.ts` › 组内一段脏 → 整组重封装 |
| — | 磁盘预检 = 源×1.05 + 64MB；**查不出空间要放行**（未知 ≠ 没空间） | `core/merge.test.ts` › 预算公式 / freeBytes=null 放行 |
| — | 源 TS 只在显式 `cleanupSources` 且全部成功后才删 | `core/postprocess.test.ts` › 默认保留 / 显式清理标 cleaned |
| — | 同会话并发触发返回 busy（否则两个 ffmpeg 抢同一个输出） | `core/postprocess.test.ts` › 并发第二次 busy |
| — | 库丢了也能合：manifest 是媒体的自描述载体 | `core/postprocess.test.ts` › 库里没记录时用 manifest 补齐 |
| — | 恢复扫描：未收尾标 interrupted、可解析 TS 就地抢救、不可解析进 orphan、丢失留证 | `core/recovery.test.ts`（5 条） |
| — | 恢复必须幂等（daemon 每次启动都跑） | `core/recovery.test.ts` › 连跑两次 |
| — | 产物时长校验 ±2%（至少 1s），异常即失败 | `core/ffmpeg.test.ts` › 合并判据 / `merge.test.ts` |

## 3. M3 插件宿主

| # | 教训（出处） | 落点 |
|---|---|---|
| — | 协议 2 字段**平铺**，包一层 payload 会让所有插件失效 | `protocol/protocol.test.ts` ＋ `server/resolver.test.ts`（真实插件返回平铺字段） |
| — | 插件短命无状态：一问一答、写完关 stdin | `protocol/host.test.ts` › 请求是平铺 JSON Lines |
| — | 响应必须按 `id` 匹配（插件自己打印的 JSON 不能串台） | `protocol/host.test.ts` › id 不匹配被忽略 |
| — | 超时必 kill → `NETWORK`（可重试） | `protocol/host.test.ts` › 超时 |
| — | 没响应就退出 → `INTERNAL`（不是 NETWORK，否则退避到天荒地老） | `protocol/host.test.ts` › 未响应就退出 |
| — | per-plugin 并发上限 + per-platform **预约式**最小间隔（防风控） | `protocol/host.test.ts` › 两道闸 |
| — | 清单白名单：绝对 exec / 路径穿越 / 未知占位符一律拒绝 | `protocol/manifest.test.ts` › 白名单 4 条 |
| — | 同名插件高优先级层胜出，且**结构化报告**谁遮住了谁 | `protocol/manifest.test.ts` › 遮蔽 |
| — | 加平台 = 加一行表：plugin.json 与 platforms.py 不许两处抄两份 | 插件自带 `test_platforms.py`（ManifestSync 3 条） |
| — | cookies_out 自动写回凭据闭环 | `server/resolver.test.ts` › resolve 写回 cookie:fake |
| — | `AUTH_REQUIRED` 原样上抛（引擎据此换 needs_auth） | `server/resolver.test.ts` › AUTH_REQUIRED |
| — | 真机链路：发现 → 启动计划 → 真实子进程 → 字段映射 | `server/resolver.test.ts`（5 条，Node 写的桩插件） |

## 4. M4 控制面 / 鉴权 / 通知

| # | 教训（出处） | 落点 |
|---|---|---|
| — | 三个标志正交：`monitor_enabled` / `record_requested` / `check_now` | `server/api.test.ts` › 三个标志互不覆盖 |
| — | 参数非法一律 400 且不落库（分段 30..43200、单场 600..21600、体积 1MiB..100GiB） | `server/api.test.ts` › 非法参数 400 |
| — | 后处理是 202 + 事件反馈，不是同步 HTTP | `server/api.test.ts` › 202 |
| — | 事件流可按 `since` 游标补齐（WS 断线的兜底） | `server/api.test.ts` › since 游标 |
| — | 未登录全端点 401（未知 `/api` 也先 401，fail-closed） | `server/app.test.ts` › 未知路径 |
| — | 非安全方法缺 `X-TideWatch-Client` → 403（CSRF） | `server/app.test.ts` |
| — | **WS 升级必须认证**（否则局域网任何人 `wscat` 就能看流水） | `server/api.test.ts` › 无 cookie 升级被拒 401 / 带 cookie 收到 hello |
| — | 设置项"谁在什么时机读"：轮询需重启，其余立即生效（提示语要区分） | `server/api.test.ts` › 设置 note |
| — | 通知纪律：info 只进铃铛、warn/error 才外发、同 (kind,task) 10 分钟去重 | `notify/dispatcher.test.ts`（6 条） |
| — | 渠道失败/抛异常只记账，不影响其他渠道与录制 | `notify/dispatcher.test.ts` |
| — | 诊断包落 `exports/` 并返回路径（无壳形态没有保存对话框） | `server/api.test.ts` › 诊断包（曾因 SQL 双引号 500，已修） |
| — | `/api/videos` 只放行录制目录内（防目录穿越） | `server/api.test.ts` › 403 |
| — | 优雅退出只有一条管道：HTTP 控制端点与 SIGTERM/SIGINT 同路 | `packages/server/src/cli.ts` 单一 `shutdown()`（人工：`curl -X POST /api/shutdown` 后进程退出、端口释放） |

## 5. M5 UI

| # | 要求 | 落点 |
|---|---|---|
| — | 控件语义三分法：复选框=自动 / 按钮=这一场 / 徽标=状态 | `pages/Overview.tsx` + `api.test.ts` 的控制面契约 |
| — | 时间轴图形化：段色块 + 缺口斜纹 + 中断竖线，数据全部来自事件表 | `pages/SessionDetail.tsx`（gaps/markers 由 `recording.gap`、`recording.stalled` 等派生） |
| — | 响应式：桌面侧边栏 + 手机底部导航；390px 视口不横向滚动 | `App.tsx`（`lg:` 断点 + `lg:hidden` 底部导航） |
| — | 明确告知删除任务的后果（级联删除历史索引，磁盘文件保留） | `pages/Overview.tsx` 删除确认文案 |

> 已知产品行为（不是缺陷）：`sessions.task_id` 是 `ON DELETE CASCADE`，
> 删除任务会连带删掉会话/分段/产物**索引**，磁盘文件保留。
> 若要保留历史，需要改成软删除或 `SET NULL`（涉及迁移，未在本期范围）。

## 6. 待真机验收（自动化替代不了的部分）

每条都是"跑一次、看一眼"的动作，交付前必须做完并记录结果。
**可执行版本见 [`docs/manual-test.md`](./manual-test.md)**（逐条命令、通过判据、排错对照表）。

- [x] **B站真机短录**：`tidewatch serve` → 加一个真实直播间 → 开录 2 分钟 → 产物可播、段边界连续、manifest 无 gap
      ✅ **2026-10-29 通过**（ffmpeg 9.0.2 vendor / 房间 5050）
      - 链路：`POST /api/tasks` 触发真实 Python 插件 probe（主播 `EdmundDZhang`、标题正确）→ resolve → 起 ffmpeg
      - 录制 154.4s / 47.5MB 单段 TS，`integrity=ok`，layout `h264-1280x720-yuv420p+aac-48000-2`（720p60）
      - 停止后 merge 出 44.6MB mp4，`ffprobe` 复核：h264 + aac、1280×720@60、154.25s，`end_reason=manual`
      - 产物落盘后才 rename（先 `.tmp-`）与"源 TS 保留"两条硬约束均成立
      - **发现并修掉的问题**：静态 ffmpeg 不带 CA 搜索路径 → 任何 https 都 `certificate verify failed`，
        表现为"一开就 `stream_eof` 重连"，看不出是证书问题。已在 `service.ts` 注入 `SSL_CERT_FILE`
        （见 `tlsEnv()`），修前 0 字节、修后立即出流
      - 待跟进：该房间匿名只协商到 `qn=250 超清`（720p），非原画；`quality_options` 只报 `['超清']`，
        属 M3 画质协商遗留项
- [ ] **抖音真机短录**：同上（验证请求头注入与 `-headers` 顺序）
- [ ] **断网重连**：录制中拔网线 30s 再插回 → 同会话续录、时间轴出现缺口斜纹、`recording.gap` 有记录
- [ ] **强杀恢复**：录制中 `kill -9` → 重启 → 会话标 interrupted、正在写的段被 recovered、可合并
- [ ] **短 cap 滚动**：把 `maxSessionS` 调成 600、段长 30 → 观察 10 分钟出现 `origin=cap` 的第二场
- [ ] **手机浏览器**：iPhone Safari / Android Chrome 打开 LAN 地址 → 登录、看任务、播放产物、时间轴不溢出
- [ ] **通知到达**：配 ntfy 或 Bark → 制造一次合并失败 → 手机收到推送，铃铛未读 +1
- [ ] **反代/隧道**：Tailscale Serve 或 Caddy 前置 → 事件流不被缓冲（服务端每 25s 发 `{"type":"ping"}` 保活，2026-10-31 补上；此前代码里并没有心跳，只有事件推送）
