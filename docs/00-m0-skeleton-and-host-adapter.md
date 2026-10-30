# M0 — 项目骨架与平台边界（TS 全栈 · 纯 daemon 形态）

> 状态：**v2 草案，待评审**。2026-10-29 修订。
> **决策记录（2026-10-29）**：交付形态选 **B 纯 daemon（无桌面客户端）**，
> 访问范围 **支持局域网**。据此**撤销** 2026-10-28 的 "Electron 客户端" 方案：
> Electron 壳、托盘、系统通知、safeStorage、electron-builder、公证签名全部退出范围。
> 行为规范的事实源仍为 tide-cap-master 的 docs/02/03/04/08/09/11；本文档只定义结构、边界与安全。
>
> **项目名（2026-10-29 定稿）**：**TideWatch**（中文仍称"潮录"）。取"观潮"意——自动盯播、
> 开播即录才是产品真正的差异点。落地映射：包 scope `@tidewatch/*`、CLI `tidewatch serve`、
> 服务名 `tidewatch`、session cookie `tw_session`、环境变量前缀 `TIDEWATCH_`、
> CSRF 头 `X-TideWatch-Client`。
> ⚠️ **不要**把 `tide-cap-master` 一起改名——那是源项目（行为规范的事实源）的目录名。

---

## 0. 一句话

**一个 Node 常驻服务 + 一份随服务分发的 React 静态资源**，浏览器即客户端；
平台差异只存在于 HostAdapter 与分发脚本；局域网访问靠 token 鉴权，通知靠外发推送渠道。

## 1. 形态与范围

```
tidewatch serve            ← 唯一形态：前台/服务方式常驻，监听 127.0.0.1 与 LAN
http://<host>:8686       ← 任意设备浏览器访问（手机/平板/另一台电脑）
tidewatch <subcommand>     ← CLI：status / diagnose / add / record / stop / token
```

**做**：录制引擎、插件协议、后处理、恢复、控制面、REST+WS、鉴权、通知渠道、诊断包、
三端分发（Docker / brew / 单文件二进制 + 服务注册）、响应式 UI。
**不做**：桌面壳与托盘、系统原生通知、多用户账号体系（单租户，见 §5）、移动 App、弹幕、云上传。

## 2. Monorepo 骨架

```
tidewatch-daemon/
├── packages/
│   ├── core/          # 引擎：状态机/监督循环/分段/manifest/合并/恢复/VOD 下载
│   │                  #   纯逻辑：零平台 API、零 HTTP、不 import server
│   ├── store/         # better-sqlite3 + schema v12 迁移（表结构照抄原版）
│   ├── protocol/      # stdio JSON 插件协议（协议 2 原样）+ 注册表/节流/路径白名单
│   ├── server/        # fastify + ws：REST/WS/静态资源/鉴权中间件/限流
│   ├── notify/        # 通知渠道（ntfy/Bark/Telegram/SMTP/Web Push）+ 去重
│   ├── host-adapter/  # 接口 + darwin/win32/linux 三实现（全部平台差异）
│   └── ui/            # React + Vite（构建产物由 server 以 SPA 分发）
├── plugins/streamget-plugin/   # Python 插件，原样平移
├── tools/assemble-resources.mjs
├── deploy/{docker,brew,systemd,launchd,windows-service}
└── docs/
```

**依赖方向**：`core → store/protocol`；`server → core/notify`；`ui → 只认 HTTP/WS 契约`。
`core` 出现 `process.platform` 分支或 HTTP 相关 import 即设计事故。

## 3. HostAdapter（七项 → 五项，纯 daemon 下更薄）

```ts
export interface HostAdapter {
  readonly platform: 'win32' | 'darwin' | 'linux';
  processes: ProcessSupervisor;   // ① 进程树级联终止 + 退出必回收
  credentials: CredentialStore;   // ② 系统钥匙串（见 §4 降级红线）
  service: ServiceControl;        // ③ 开机自启 = 服务注册（launchd/systemd/计划程序）
  paths: { dataRoot(): string; resourceRoot(): string; defaultDownloads(): string };
  lease: { acquire(dbPath: string): Promise<LeaseResult> };  // ④ 引擎单实例
}
// 已删除：tray / dialogs（无壳形态无消费者）
// 通知不在 adapter：它是 server 侧渠道，见 §6
```

**Headless 语义要点**：
- 退出入口**不能只靠信号**（Windows 没有 `SIGTERM`：`taskkill`、计划程序"结束任务"都是无条件终止，
  不跑任何 handler）。因此定义为一条管道、三个触发源：
  - **主入口 = 控制端点**：`tidewatch stop` → `POST /api/shutdown`（需认证/仅本机），三平台同一实现，
    执行**与"托盘退出"完全相同的优雅收尾**（等 runner → 超时硬杀 → 恢复扫描兜底）；
  - **Unix 附加入口**：`SIGTERM`/`SIGINT` 转调同一管道（systemd / launchd 停止走这里）；
  - **Windows 附加入口**：服务/计划程序停止 → 后置脚本调 `tidewatch stop`；`taskkill /F` 视为崩溃路径，
    由启动期恢复扫描兜底。
  漏了主入口，Windows 上停一次服务就丢一场后处理；
- 无对话框：诊断包等产物落到 `paths.dataRoot()/exports/`，路径在接口返回里给出；
- 无托盘：进程存活状态由 `tidewatch status`、mDNS（`tidewatch.local`）、首页健康条三处表达。

## 4. 鉴权与安全（M4 前置，不可延后）

局域网暴露意味着**任何能访问该 IP 的人都能看到你的录制、任务与 Cookie 掩码**。

| 项 | 设计 |
|---|---|
| 首次启动 | 生成 32 字节 token → 打印终端 + 写 `data/auth-token.txt`（0600）；`tidewatch token --show` 可再取 |
| 登录 | UI 贴 token → 换 **HttpOnly + SameSite=Lax** session cookie（随机 id，服务端内存+库双存，7 天滚动） |
| WS | 同源 cookie 认证；无 cookie 的 upgrade 直接 401（不走 query token——会进访问日志） |
| CSRF | 状态变更请求必须带自定义头 `X-TideWatch-Client: 1`（跨站无法伪造） |
| 限速 | 登录端点 5 次/分钟/IP；WS 连接数上限 |
| 绑定 | 默认 `0.0.0.0:8686`；`TIDEWATCH_BIND=127.0.0.1` 可收回本机；`TIDEWATCH_TRUST_PROXY` 供反代取真实 IP |
| 凭据 | Cookie 值仍只存系统钥匙串；`GET /api/cookies` **只回掩码**；不可用时降级明文并上报 `encrypted=false`（原版红线原样保留） |
| 审计 | 变更类请求全部进 audit_log（含来源 IP） |
| 明文传输 | 内网 HTTP 视为已知风险并在文档写明：跨不可信网络请用 Tailscale/Caddy 反代加 TLS |

## 5. 单租户定位（明确写死）

LAN 访问 = 多人可能打开同一界面，但**这不是多用户系统**：所有人共享同一份数据与权限，
没有角色、没有隔离。文档与 UI 都要说明"这是你自己的服务，别把它当团队平台"。
真要做多用户，是另一个量级的改造（数据分区 + 权限模型），不在本期范围。

## 6. 通知（升级为 M4 硬需求）

无壳形态没有系统通知，通知必须外发，否则"合并失败三天后才发现"。

| 层 | 位置 | 职责 |
|---|---|---|
| 文案 | `core/notify` 纯函数 | 事件 + 上下文 → `{kind, level, title, body}`（沿用原版文案表） |
| 派生 | `notify/dispatch` | 订阅总线 → 筛类别 → 去重（kind+task 10 分钟）→ 落库 → 扇出渠道 |
| 存储 | `store/notifications` | 列表/未读/已读/剪枝（上限 500） |
| 渠道 | `notify/channels/*` | ntfy / Bark / Telegram / SMTP / Web Push；各自独立失败计数与重试，失败不影响其它渠道与录制 |

纪律不变：只有 `warn/error` 外发；`info` 只进铃铛；渠道配置在设置页可逐项测试（发一条测试消息）。

## 7. 分发（无客户端 = 无签名负担）

| 目标 | 产物 | 自启方式 |
|---|---|---|
| NAS / Linux 服务器 | **Docker 镜像**（含 node + ffmpeg + python 运行时），卷映射 `/data` | `restart: unless-stopped` |
| macOS（Intel/ARM） | zip + `brew` formula（**无需公证**）；`launchd` LaunchAgent | `brew services start tidewatch` |
| Windows | 单文件二进制（bun/node SEA）+ `nssm`/schtasks 注册 | 计划程序「登录时启动」 |
| 通用兜底 | `npm i -g` 或 tarball + 脚本 | systemd user unit 模板随包分发 |

资源路径在容器内固定为 `/data`（`TIDEWATCH_DATA_DIR` 覆盖），与原版"数据根五档解析"共存：
容器档位优先读环境变量，坏指针拒启动的语义保留。

## 8. 原版机制 → TS 映射（修订：删除 Electron 行）

| 原版 | 重构版 | 备注 |
|---|---|---|
| tokio broadcast EventBus | 有界队列 EventBus（满则丢广播，落库照写） | UI 慢不阻塞录制（try_send 语义） |
| axum REST+WS | fastify + ws | 端点契约照抄，加鉴权中间件 |
| SQLite WAL | better-sqlite3（**无需 electron-rebuild**） | 原生模块只需 node-gyp 三端预编译 |
| keyring crate | macOS `security` / Linux `secret-tool` / Windows DPAPI（或 keytar 系） | 统一在 adapter；失败降级明文 + `encrypted=false` 上报 |
| 文件锁 lease | `O_CREAT\|O_EXCL` 句柄绑定 | 抢不到 → 退出码 2（唯一宿主形态更简单：直接退出） |
| Job Object / process group | win: Job Object（napi 或 `taskkill /T`）；unix: `detached`+`kill(-pgid)` | 唯一重平台点 |
| ffmpeg 参数 | **逐字节复用**（`-f segment` / `-progress pipe:1` / `-headers` 渲染） | `out_time_us` 教训进注释 |
| 数据根解析 | 照抄 docs/11 五档 + 坏指针拒启动 | 容器档由 env 接管 |
| 静态 UI | Vite 产物由 fastify 以 SPA 分发（`/` fallback） | 浏览器/手机/未来 PWA 同一份 |

## 9. 测试策略

- 回归锁来源：tide-cap-master 的 docs/03/08/09 测试清单 → `docs/test-matrix.md` 逐条登记；
- 单测 vitest（core/store/protocol/notify 纯逻辑）；server 契约测试照原版改写；
- **鉴权专项**：无 token 访问全端点 401、WS 未认证拒绝、跨站伪造头缺失被拒、登录限速；
- 插件 pytest 38 条原样跑；
- 真机：每里程碑真机验收（含**手机浏览器**访问验收：响应式布局、播放、操作）。

## 10. 风险

| 风险 | 应对 |
|---|---|
| 无托盘 → 用户不知道在跑/忘了怎么停 | `tidewatch status`、mDNS、首页健康条；文档首屏就给"怎么开机自启/怎么退出" |
| 通知到达率 | 多渠道扇出 + 设置页测试按钮；关键失败同时落库并在铃铛常驻未读 |
| LAN 明文 HTTP 被嗅探 | 文档明示；推荐 Tailscale/Caddy 反代；Cookie 值永不出服务端 |
| PWA/Web Push 在 `http://<LAN-IP>` 不可用 | 措辞写清：需要 secure context；给 Tailscale Serve 方案；默认靠外发推送 |
| Python 运行时打包（容器内简单，裸机复杂） | 容器档内置；裸机档 M3 再定（评估 python-build-standalone 或 TS 重写插件） |
| 行为资产搬迁走样 | test-matrix 强制：文档里的每条教训必须对应一条回归测试或验收步骤 |

## 11. 里程碑

| 里程碑 | 内容 | 验收锚点 |
|---|---|---|
| M0 | 骨架 + adapter 接口冻结 + 鉴权骨架 | 无 token 全端点 401；core 零平台分支 |
| M1 | 引擎（状态机/监督/stderr 分类/分段/manifest） | I1–I5 + 抖音/B站真机短录 |
| M2 | 后处理（同构分组/concat/原子替换）+ 恢复 | 重合并不毁产物；中断抢救 |
| M3 | 插件宿主 + streamget | 38 条离线用例 + 真机解析 |
| M4 | 控制面 + API + WS + 鉴权完成 + 通知渠道 | 短 cap 滚动（docs/09 §6）+ 手机收推送 |
| M5 | UI 重做（含响应式） | 桌面 + 手机浏览器双端走查 |
| M6 | 分发（Docker/brew/服务注册/反代文档） | 三端真机安装 → 开机自启 → 录制 → 重启恢复 |

## 12. 落地状态（2026-10-30）

**M0–M5 已完成**：`127` 条自动化测试全绿，lint / typecheck 干净，
真实进程走通了「启动 → 登录 → 插件发现 → probe → 解析 → 优雅退出」。
逐条教训与测试的映射见 **`docs/test-matrix.md`**（交付前还需补 §6 的真机项）。

```
packages/
├── core/           # 引擎（状态机/两层重连/看门狗/分段/manifest）、后处理、恢复
├── store/          # node:sqlite + schema v12（tasks/sessions/segments/artifacts/
│                   #   notifications/settings/events/audit_log/runtime）
├── protocol/       # 协议 2 + 清单白名单 + 注册表遮蔽 + 插件宿主（三道闸）
├── notify/         # 派生层（去重/扇出）+ ntfy/Bark/Telegram/SMTP/WebPush
├── host-adapter/   # 五项接口 + 三平台实现（进程树/钥匙串/服务注册/路径/租约）
├── server/         # fastify REST + WS + 鉴权 + SSE 未采纳；CLI：serve/status/token/diagnose/stop
└── ui/             # React 19 + Vite + Tailwind 4：总览/录制/会话详情（图形化时间轴）/设置
plugins/streamget-plugin/   # Python 插件原样平移（40 条离线用例通过）
```

**里程碑逐项**：

| 里程碑 | 状态 | 关键证据 |
|---|---|---|
| M0 骨架 + 鉴权 | ✅ | 未登录全端点 401、CSRF 403、退出单管道（`app.test.ts`） |
| M1 引擎 | ✅ | 9 条引擎用例：两层重连、缺口记账、看门狗、cap 滚动、shutdown 收尾（`engine.test.ts`） |
| M2 后处理/恢复 | ✅ | 失败不毁产物、组级同质化、manifest 兜底、恢复幂等（`postprocess/merge/recovery.test.ts`） |
| M3 插件宿主 | ✅ | 真实子进程端到端 5 条 + 插件 40 条离线用例；`streamget` 在真机 daemon 里 probe 成功 |
| M4 控制面/通知 | ✅ | 13 条 API 契约（含 WS 鉴权）+ 6 条通知派发；诊断包导出落地 |
| M5 UI | ✅ | 图形化时间轴（段/缺口斜纹/中断竖线）、桌面+手机双布局 |
| M6 分发 | ⬜ | Docker/brew/服务注册与反代文档未做 |

**本轮修掉的真实缺陷**（都是测试写出来才暴露的）：

1. 宿主退出时 `reason` 被记成 `manual` → 退出过程中仍会拉起 ffmpeg 合并（`shutdown` 判定被 `manualStop` 抢先）；
2. 跨连接段号按 seglist 下标推算 → 第二次连接起段号跳号，与文件名不一致；
3. `store.stats()` 用双引号写 SQL 字符串字面量 → 诊断包导出 500；
4. 缺 ffmpeg 时表现为"重连 unknown"无限重试 → 改为 `needs_dep` + 可操作提示 + 一条通知。

**已知产品行为**：删除任务会级联删除会话索引（磁盘文件保留），UI 已在确认框写明。

