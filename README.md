# TideWatch（潮录）

给直播间装一台"自动录像机"：**加一次地址，之后开播自动录、下播自动合并成 MP4**。
常驻服务 + Web UI，浏览器就是客户端，手机连同一个局域网也能看。

当前版本 `0.0.0`，M0–M5 已闭环（引擎 / 后处理与恢复 / 插件宿主 / 控制面 / UI），
M6 的部署件（Docker、brew、systemd 模板目录）还空着——服务化目前走 `tidewatch service install`。

---

## 能做什么

| 能力 | 说明 |
|---|---|
| 自动录制 | 轮询直播间状态，开播即录；下播自动收尾。抖音 / B 站走 `streamget` 插件，`.m3u8` 直链直接可用 |
| 手动接管 | 每个任务可随时"开始/停止录制"、"立即检查"、"本场跳过"，不打断监控 |
| 抗中断 | 分段 TS 每 30 秒落盘（可配），manifest 是事实源；进程被 `kill -9` 也能在下次启动时恢复、合并 |
| 断流重连 | 流地址过期 / 网络抖动自动重取，缺口记进事件表并在时间轴上标出来 |
| 后处理 | 合并为一个 MP4 / 每段独立 MP4 / 只落 TS 手动触发；`faststart` auto/on/off |
| 硬上限 | 单场时长与体积上限（默认 6 小时、20 GiB），到顶后按 `capped` 结束并自动承接下一场 |
| 通知 | ntfy / Bark / Telegram / SMTP / Web Push，服务端账本 + 10 分钟去重，UI 里有未读角标 |
| 可观测 | 会话时间轴（分段、缺口、崩溃抢救 marks）、事件流水、审计日志、一键诊断包 |
| 任务规模 | 总览只放最近 6 条，全量在「任务」页：卡片墙（宽屏一行三列）+ 状态分组 + 搜索筛选，首屏高度不随任务数线性增长 |

## 不做的事（故意的边界）

- 不是下载器也不做转码流水线：只落 TS 与合并后的 MP4，源分段默认保留。
- 不碰 DRM、不破解付费内容；需要登录态的平台靠你自己提供 Cookie。
- 没有桌面壳，所以**没有系统通知**——通知必须走服务端渠道。
- 匿名访问下 B 站只到 720p60（`qn=250` 超清），原画需要登录 Cookie，这是平台侧限制。

## 架构

```
packages/ui        React 19 + Vite 8 + Tailwind 4，hash 路由，构建产物由 server 静态分发
      │  REST + SSE(/api/events/stream，主) / WS(/api/ws，兜底)
packages/server    Fastify 5：鉴权、任务/会话/设置/通知/插件/诊断路由，SPA 分发
      │
packages/core      引擎：轮询、录制、分段、重连、恢复、合并（纯函数 + Runner）
      │
packages/store     node:sqlite（WAL）迁移与查询；packages/protocol 插件清单与 stdio JSON 协议
packages/host-adapter  五项平台差异（路径、进程、钥匙串、租约、服务注册）
packages/notify    通知渠道扇出
plugins/streamget-plugin  Python 插件（抖音 / B 站抓流），走 stdio JSON 协议
```

平台差异全部收敛在 `host-adapter` 的 `HostAdapter` 里，`core` 不认识任何操作系统细节。

## 快速开始

要求：**Node ≥ 24**、**pnpm 12**；ffmpeg 由脚本下载，不需要手动装。

```bash
pnpm install
pnpm -r build
pnpm fetch:ffmpeg                       # 下载 ffmpeg + ffprobe 到 vendor/ffmpeg/bin（已存在则跳过）
node packages/server/dist/cli.js serve  # 默认 :8686，监听 0.0.0.0
```

启动横幅会打印数据根、本机地址、**局域网地址**和 token：

```
  TideWatch daemon 已启动  (pid 56314)
  数据根     /Users/you/TideWatch/data
  本机访问   http://127.0.0.1:8686
  局域网访问 http://10.0.0.20:8686
  访问 token 9bb2f9d5…
```

浏览器打开 <http://127.0.0.1:8686>，粘贴 token 登录，在「总览」或「任务」页贴一个直播间地址即可。
房间多了以后用「任务」页：任务卡按状态分组、宽屏一行三列，带搜索与筛选（搜索条滚动时钉在顶部）。
完整操作说明见 **[docs/user-guide.md](docs/user-guide.md)**。

## 常用命令

| 命令 | 作用 |
|---|---|
| `node packages/server/dist/cli.js serve` | 启动（唯一常驻形态）；`-p` 端口、`-H` 监听地址、`-d` 数据根 |
| `… cli.js token` | 打印访问 token（本机操作） |
| `… cli.js status` | 查询 daemon 健康状态（JSON） |
| `… cli.js stop` | 优雅停止（等同 SIGTERM：等录制收尾 → 超时硬杀 → 恢复扫描） |
| `… cli.js add <url>` | 命令行加任务（默认开监控），`--no-monitor` 只加不监控 |
| `… cli.js record <taskId> [--stop]` | 手动录/停这一场 |
| `… cli.js diagnose` | 导出诊断包到 `<data>/exports/` |
| `… cli.js service install\|uninstall\|status` | 开机自启（launchd / systemd --user / 计划任务） |
| `pnpm test` | 全量单测（16 文件 / 133 条） |
| `pnpm lint`、`pnpm typecheck`、`pnpm build` | 门禁三件套 |
| `node tools/smoke.mjs --port 8686 --data ./data` | 控制面冒烟（7 项断言，`--shutdown` 顺手停） |

## 数据与产物

```
data/
  auth-token.txt          访问 token（0600），首次启动生成，之后固定
  tidewatch.db            node:sqlite（WAL），任务/会话/分段/事件/通知/审计
  credentials.json        仅在系统钥匙串不可用时出现的明文降级（会如实标"未加密"）
  downloads/<主播>/<YYYYMMDD-HHMMSS>_<new|cap>_<taskId8>/
      <taskId>_part001.ts …       源分段，默认保留
      session.manifest.json       这一场的事实源
      <主播>_<YYYYMMDD>_<HHMMSS>.mp4
  exports/                诊断包
  plugins/                用户级插件（覆盖内置同名插件）
```

## 配置

优先级：**环境变量 > 设置页（存 sqlite）> 内置默认**。

| 变量 | 作用 |
|---|---|
| `TIDEWATCH_DATA_ROOT` | 数据根（默认：仓库根的 `data/`，脱离仓库时退回 `./data`） |
| `TIDEWATCH_FFMPEG` / `TIDEWATCH_FFPROBE` | 指定二进制绝对路径，优先级最高 |
| `TIDEWATCH_PYTHON` | 插件用的 python3（默认 `vendor/python/bin/python3`，没有则 PATH 上的 `python3`） |
| `TIDEWATCH_SECURE_COOKIE=1` | HTTPS 反代下给会话 cookie 加 `Secure` |

设置页里可调：轮询间隔（5–3600s，默认 30）、分段时长（30–43200s，默认 1800）、默认后处理、
faststart 与阈值（默认 auto / 512 MB）、是否清理中间文件、通知渠道、录制目录。
轮询间隔与录制目录**重启生效**，其余立即生效。

## 部署

```bash
# 1) 服务化（当前用户，无需 root）
node packages/server/dist/cli.js service install      # 日志在 <data>/logs/
# 2) 对外只给内网 / 反代
node packages/server/dist/cli.js serve -H 127.0.0.1  # 再挂 nginx / Caddy / Tailscale Serve
```

**安全底线**：能访问这个端口的人就能删你的录制，token 是唯一门槛。别把 8686 直接暴露到公网；
走 HTTPS 反代时记得 `TIDEWATCH_SECURE_COOKIE=1`，否则 cookie 在跨站场景会被浏览器丢掉。
登录接口限速 5 次/分钟。

## 开发

```bash
pnpm dev        # 服务端 tsx watch，:8686
pnpm dev:ui     # Vite dev server，:5180，/api 反代到 8686
pnpm test       # vitest
```

引擎侧代码必须保持"纯函数 + 薄壳"：`core` 里不出现 `fs`、`child_process`、平台 API，
所有 IO 都从 `HostAdapter` 或注入的端口进来——这是这套代码能被单测覆盖的唯一原因。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/user-guide.md](docs/user-guide.md) | **使用手册**：安装、登录、界面逐页说明、任务与产物、设置项全表、通知、Cookie、插件、CLI/API 参考、排错、FAQ |
| [docs/manual-test.md](docs/manual-test.md) | 真机测试手册（8 条验收项与判据） |
| [docs/test-matrix.md](docs/test-matrix.md) | 测试矩阵与覆盖现状 |
| [docs/00-m0-skeleton-and-host-adapter.md](docs/00-m0-skeleton-and-host-adapter.md) | 骨架与平台适配设计 |
| [docs/01-ui-redesign.md](docs/01-ui-redesign.md) | UI 信息架构与页面设计 |
| [docs/02-daemon-stack.md](docs/02-daemon-stack.md) | 守护进程技术栈与运行时约束 |

## 已知限制

- 画质协商只走匿名档位（B 站 720p60）；`quality_options` 目前只报一个可选值。
- 删除任务会级联删掉它的会话索引（**磁盘视频不删**）；要留历史就只关监控别删任务。
- daemon 重启后内存里的登录会话清空，各端要重新粘一次 token（token 本身不变）。
- Docker / brew formula / 反代示例还没落地（M6）。
- 通知渠道失败只写审计日志，不会重试。

## 许可证

未指定（当前为私有项目）。
