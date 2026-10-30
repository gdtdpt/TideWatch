# 02 — daemon 技术栈（定稿）

> 状态：**定稿候选**。2026-10-29 修订（前提变更：**不要求单文件 exe 分发** →
> 原生依赖不受限，直接选成熟组件）。
> 其余前提不变：纯 daemon 形态、局域网访问、三平台（macOS Intel 先落地）、
> 行为规范沿用 tide-cap-master docs。

## 1. 全局一览

```
                  ┌──────────────────────────────────────────┐
   浏览器 / 手机 → │ Fastify 5 · REST + WS + 静态 SPA + 鉴权   │
                  ├──────────────────────────────────────────┤
                  │ core（状态机/监督/分段/合并/恢复/VOD）     │
                  │ notify（去重 + 渠道扇出）                  │
                  ├──────────────────────────────────────────┤
                  │ node:sqlite（WAL）· plugin-host（stdio）  │
                  │ host-adapter（五项平台差异）               │
                  └──────────────────────────────────────────┘
                       ↓ spawn                    ↓ spawn
                  ffmpeg 子进程            Python 插件进程（streamget）
```

## 2. 运行时与语言

| 项 | 选型 | 说明 |
|---|---|---|
| 运行时 | **Node.js 26 LTS**（`engines: >=24`） | 26 于 2026-10-27 转入 Active LTS，安全支持到 2029-04；floor 设 24 以兼容 brew/发行版自带版本。**22 已进 maintenance（2027-04 EOL），不作为目标** |
| 语言 | **TypeScript 6.x**，`strict` + `noUncheckedIndexedAccess`，ESM | 三处契约（API / 插件协议 / schema）共用类型。**暂锁 6.x**：typescript-eslint 8 明确拒绝 TS 7.0（见 §2.1） |
| 包管理 | **pnpm 12** workspace | 内容寻址 + 严格依赖；安装脚本白名单用 `allowBuilds`（pnpm 12 已不用 `onlyBuiltDependencies`） |
| 构建 | `tsc` 产出 JS；UI 由 Vite 构建 | 不做单文件打包，产物保持可读、堆栈可定位 |
| 开发 | `tsx --watch` | 免编译热跑；Node 原生 `--watch` 作备选 |

### Node 版本策略（2026-10-29 核对）

| 版本线 | 状态 | 关键日期 |
|---|---|---|
| **26（LTS）** | **Active LTS**（2026-10-27 转正） | 安全支持至 2029-04 |
| 24（LTS） | Maintenance（2026-10-20 起） | 安全支持至 2028-04 |
| 22（LTS） | Maintenance，**只剩 6 个月** | 2027-04-30 EOL |

- **基线 = 26**，`.node-version` / `.nvmrc` 写 `26`，Docker 用 `node:26-slim`；
- **`engines: ">=24"`**：brew 与发行版自带 24 的用户不被拦；24 仍受安全支持到 2028-04；
- **CI 双线矩阵 24 + 26**：防止无意用到 26 独有 API 而把 24 用户挡在门外；
- **patch 版本不进文档**，由 lockfile 与 CI 固定——文档写死补丁号必然过期；
- 原生依赖的 ABI 顾虑已排除：`@napi-rs/keyring` 与自写 Job Object addon 走 **Node-API**（跨大版本稳定，无需重编）；数据层已改 `node:sqlite`（见 §4/§8.4），不再有 `better-sqlite3` 的 V8 ABI 绑定。

### 2.1 实现期约束（2026-10-29 骨架落地时确认）

| 约束 | 事实 | 处置 |
|---|---|---|
| TypeScript 版本 | 装到 7.0.2 时 `eslint` 直接报 `typescript-eslint does not support TS 7.0` 并退出 | **锁 `typescript@^6`**（6.0.3 已验）；typescript-eslint 支持 7.1+ 后再升，届时跑一遍全量回归 |
| pnpm 安装脚本 | pnpm 12 用 `allowBuilds` 映射表授权 postinstall；`onlyBuiltDependencies` 已失效（会报 `ERR_PNPM_IGNORED_BUILDS`） | `pnpm-workspace.yaml` 写 `allowBuilds: { esbuild: true }`，将来加原生包时补条目 |
| 相对导入写法 | NodeNext 下写 `.js` 时 Vite/vitest 解析不到磁盘上的 `.ts` | 源码统一写 **`.ts` 扩展名**，靠 `rewriteRelativeImportExtensions` 在产物里改回 `.js`；顺带让 Node 26 能直接执行 TS，测试不需要任何解析插件 |
| 测试导入 | vitest 5 的 `resolve.alias` 不参与测试文件的模块解析 | 同上：写 `.ts` 即可，无需 alias / 插件 |

> 这三条都是"踩了才知道"的环境事实，写进文档是为了后来者不用再踩一遍。

## 3. 服务端

| 关注点 | 选型 | 为什么是它 |
|---|---|---|
| HTTP 框架 | **Fastify 5** | 原生 JSON Schema 校验（契约即代码）、生命周期钩子、`app.inject()` 免端口测试 |
| 类型/schema | **TypeBox** + `@fastify/type-provider-typebox` | 编译期类型与运行时 schema 同源，一份定义两处用 |
| WS | **ws**（`@fastify/websocket`） | 订阅者量级只有几十，不引 uWebSockets 原生依赖 |
| 静态资源 | `@fastify/static`（SPA fallback） | UI 与 API 同源，浏览器/手机/未来 PWA 一份产物 |
| 会话 | `@fastify/cookie`（HttpOnly + SameSite=Lax） | token 换 session，7 天滚动 |
| 限流 | `@fastify/rate-limit` | 登录 5 次/分钟/IP；WS 连接数另设上限 |
| 日志 | **pino** + **pino-roll**（按大小轮转） | 旧版否决 tracing-appender 正因为只有时间粒度；轮转 size + keep 直接配 |
| 校验边界 | 仅 API 入参用 schema；插件响应**宽容解析** | 展示字段容错、功能字段严格（旧版踩过"插件回整数 quality 让整条下载失败"） |
| HTTP 客户端 | 内建 `fetch` | 推送渠道只需出站 POST |
| 加密 | `node:crypto`（`randomBytes` / `timingSafeEqual`） | token 生成与比较，零依赖 |

## 4. 数据与文件

| 关注点 | 选型 | 说明 |
|---|---|---|
| 数据库 | **`node:sqlite`**（内建，WAL）｜备选 `better-sqlite3` | 见 §8.4：优先内建以消除原生依赖，M0 spike 判定。同步 API 与单进程模型天然契合；迁移的**顺序**（回填→去重→建唯一索引）必须手写可控 |
| 迁移 | 手写 SQL 序列 + `PRAGMA user_version` | 版本号沿用旧版（当前 12），升级脚本顺序照抄 |
| 访问层 | 薄 repo 函数（`store/tasks.ts`、`store/segments.ts`…） | 不引 ORM：本项目没有跨库需求，ORM 只会把迁移顺序藏起来 |
| 文件扫描 | `node:fs` 递归 `opendir`（自写） | 恢复扫描要精确控制深度与统计，glob 库不划算 |
| 媒体 | 不落 DB；盘上 `manifest.json` 为事实源 | 库丢了可凭文件重建；库只是索引与账本 |
| 时间/格式化 | 内建 `Intl` + 少量 helper | 不引 dayjs/moment；目录名与产物名用本地时间（旧版踩过 UTC 坑） |

> **`node:sqlite` spike 结论（2026-10-29，已通过）**：WAL 生效、`PRAGMA user_version` 读写、
> 迁移逐事务执行且失败自动回滚（不留半套 schema）、`STRICT` 表与唯一索引行为与预期一致
> —— 全部落在 `packages/store/src/db.test.ts` 三条用例里。因此**数据层零原生依赖**这条成立。

## 5. 进程与平台

| 关注点 | 选型 | 说明 |
|---|---|---|
| 子进程 | `node:child_process` + 自写 `ProcessSupervisor` | 统一 spawn/读行/优雅停止/级联终止 |
| 并集发控制 | `p-limit` + 自写**预约式**闸门 | per-plugin 信号量（默认 2）+ per-platform 最小间隔 1s（预约式才不会同时越闸） |
| 钥匙串 | **`@napi-rs/keyring`**（预编译二进制） | macOS Keychain / Windows 凭据管理器 / Linux secret-service 一个入口；不可用时降级明文并上报 `encrypted=false` |
| Windows 进程树 | **自写 napi-rs 微 addon**（Job Object, `KILL_ON_JOB_CLOSE`） | 唯一能保证宿主被强杀时 ffmpeg 一起走的机制；过渡期 `taskkill /T /F` + 启动孤儿清扫 |
| Unix 进程树 | `spawn({detached:true})` + `kill(-pgid)` | SIGTERM → 宽限 → SIGKILL |
| CLI | `commander` | `serve` / `status` / `diagnose` / `token` / `stop` |
| 服务注册 | 模板随包分发（launchd plist / systemd unit / schtasks） | 不引第三方服务库，三份模板 + 一个安装脚本 |

## 6. 前端

| 关注点 | 选型 | 说明 |
|---|---|---|
| 框架 | **React 19** + Vite | 与旧版延续，团队零学习成本 |
| 样式 | **Tailwind 4** + **shadcn/ui**（Radix 行为层） | design token 集中定义，消灭散落硬编码色值 |
| 服务端状态 | **TanStack Query 5** | 缓存/失效/重取与 WS 增量推送配合 |
| 本地状态 | **zustand** | 只放 UI 局部状态（当前页签、抽屉开合） |
| 长列表 | **TanStack Virtual** | 会话/分段列表（旧版已有虚拟滚动） |
| 表格 | **TanStack Table** | 排序/筛选/列宽，仅录制页用 |
| 路由 | **react-router 7** | 嵌套路由 + 移动端底部 Tab |
| 时间线 | **自绘 SVG**（不引图表库） | 段色块/缺口/重连标注是专用可视化，图表库反而更绕 |
| i18n | **i18next + react-i18next** | 中英对齐旧版 |
| 主题 | CSS variables（明暗单真源） | 三端同一 Chromium/Firefox/WebKit 表现一致 |

## 7. 工程基线

| 项 | 选型 |
|---|---|
| 单测 | **vitest** + `@vitest/coverage-v8` |
| 契约测试 | vitest + `app.inject()`（不起端口） |
| e2e | **Playwright**（桌面 1440 / 手机 390 双视口，真浏览器） |
| Lint | ESLint 9 flat config + `typescript-eslint`；禁 `any` 逃逸 |
| 格式 | Prettier 3 |
| CI | 三平台矩阵跑 `lint + tsc + unit + contract`；e2e 只在 Linux 跑 |
| 提交钩子 | 只跑"改动到的包"的测试（全量留 CI，否则钩子会被 `--no-verify` 绕过） |

## 8. 部署：平台差异落在哪几层

前提澄清：**"把目录连 `node_modules` 一起复制到目标机器"只对纯 JS 服务成立。** 本项目有三层
东西与平台绑定，必须分开对待：

| 层 | 内容 | 跨平台可复制 |
|---|---|---|
| **A 平台无关** | `tsc` 产物、UI `dist`、迁移 SQL、插件 `.py`、默认配置、服务模板之外的脚本 | ✅ 同一份 |
| **B 平台相关** | `.node` 原生模块、`ffmpeg` 二进制、Python 运行时、服务注册模板 | ❌ 每 `(os, arch)` 一份 |
| **C 环境** | Node 运行时（`>=24`）、系统钥匙串后端、路径与权限语义 | ❌ 目标机自备或随包 |

`.node` 的绑定是**三重**的：OS + CPU 架构 +（非 Node-API 模块的）Node ABI。所以在
`darwin-arm64` 上装出来的 `node_modules` 复制到 Windows 或 Intel mac，会在 `require`
那一刻直接失败——不是"跑得慢"，是起不来。

**结论：部署单位不是"一个目录"，而是"每平台一个 artifact"。** CI 按
`(linux|darwin|win32) × (x64|arm64)` 矩阵各自构建目录包；跨平台只复用层 A。

### 8.1 目录包形状（每平台一份）

```
tidewatch-<ver>-<os>-<arch>/
├── bin/tidewatch            # 启动器：定位自身 → 找 node（或 vendor/node）→ app/dist/cli.js
├── app/
│   ├── dist/              # tsc 产物
│   ├── node_modules/      # pnpm deploy --prod 产出（真实文件、仅生产依赖）
│   └── ui/                # Vite 产物，由 Fastify static 提供
├── vendor/ffmpeg          # 静态构建，不依赖系统 ffmpeg
├── vendor/python/         # python-build-standalone（若首插件继续用 Python）
├── plugins/streamget/
└── service/               # tidewatch.service / .plist / schtasks.xml + install|uninstall
```

两个要点：

- **必须用 `pnpm deploy --prod`，不要 `cp -r node_modules`**。pnpm 的 `node_modules` 是软链到
  `.pnpm` 内容寻址存储的结构，`cp -r`/zip/rsync 在部分环境会把软链拍平或断链，表现为
  "复制过去就找不到模块"。`deploy` 产出自包含、真实文件、只含生产依赖的目录——它是"可复制"
  这件事的前提条件。
- 可选 `vendor/node` 随包（+55MB 左右）：用户无需预装 Node。是否随包留到 M6 决定，
  不影响其余设计。
- **插件运行时依赖**：`plugins/streamget-plugin/site-packages/`（21MB，`requirements.lock` 逐包钉死）
  不入库、不打进产物，由打包脚本按目标平台现场装或烘进镜像；重建命令写在 `requirements.lock` 头注释里。
- **ffmpeg 二进制怎么来**：解析链见 `service.ts` 的 `pickBinary()` ——
  `TIDEWATCH_FFMPEG`（显式）> `vendor/ffmpeg/bin/`（随包）> `PATH`（回退，UI 会标"系统 PATH"）。
  开发机用 `pnpm fetch:ffmpeg`（`tools/fetch-ffmpeg.sh`）拉静态构建，装完把版本记进
  `vendor/ffmpeg/VERSION`；`vendor/` 不入库（层 B 平台相关件，180MB）。
  为什么不像 `ffmpeg-static` 那样靠 npm postinstall：pnpm 12 要 `allowBuilds` 白名单、
  离线机器与 CI 缓存都会卡，许可责任也转到我们身上。
- **静态 ffmpeg 的 TLS 坑**：openssl 静态构建常常不带 CA 搜索路径，直接对任何 https 报
  `certificate verify failed`；在录制上表现为"一开流就 `stream_eof` 重连"，完全看不出是证书问题。
  `service.ts` 的 `tlsEnv()` 在 `SSL_CERT_FILE` 未设置时按平台找系统 CA bundle
  （`/etc/ssl/cert.pem` / `ca-certificates.crt` / `ca-bundle.crt`）注入给 ffmpeg 子进程。
  真机验证：修前 0 字节，修后 154s/47MB 正常出流。

### 8.2 三种交付形态与它们各自消掉的差异

| 形态 | 平台差异处理 | 适用 |
|---|---|---|
| **Docker 镜像** | 层 B 全部烘进镜像（`node:26-slim` + ffmpeg + python + 插件，`linux/amd64`+`arm64`），宿主零差异 | NAS / Linux 首选；也是 macOS 用户"不想管运行时"的省心路径 |
| **目录包 + 服务注册** | 每平台 CI 构建；`service/` 三选一模板 | macOS（launchd）、Windows（计划程序）主推；macOS 另出 brew formula |
| **`pnpm i -g`** | 目标机现场装原生依赖（走 prebuild 下载） | 开发者 / 尝鲜，不作为正式分发 |

### 8.3 真正躲不开的平台语义差异（与文件无关，全部收敛进 adapter）

| 差异 | 不处理的后果 | 处置 |
|---|---|---|
| **Windows 无 `SIGTERM`** | 优雅退出链路断 → 停服务即丢一场后处理 | 退出主入口改为**控制端点**（`tidewatch stop` / `POST /api/shutdown`），信号只作 Unix 附加入口（docs/00 §3） |
| 文件锁语义（Windows 独占打开的文件不可删） | "能否删锁文件"不能当存活判据 | 锁文件写 PID + 心跳时间戳，按超时判死，不按可删除性 |
| Windows 路径上限 260 | 深目录录制 / 合并失败 | 数据根路径长度校验；关键 spawn 参数走 `\\?\` 长路径前缀 |
| macOS/Windows 大小写不敏感 | 产物去重、manifest 匹配错位 | 路径比较统一走规范化 key，不假设大小写敏感 |
| Unix `umask` / Windows ACL | `0600` 语义在 Windows 上只是近似 | adapter 内统一设权限，并在诊断包里回显实际值 |
| 系统钥匙串后端不同 | 降级路径不一致、易"谎报已加密" | 统一入口 + 显式回报 `encrypted`（红线不可破） |
| 磁盘空间查询 | — | `fs.statfs` 三平台可用，无需分支 |

### 8.4 把层 B 压到最小（决定"可复制性"的实际质量）

层 B 越小，"复制即部署"越接近成立。三项处置：

| 现状 | 处置 | 净效果 |
|---|---|---|
| `better-sqlite3`（V8 ABI 原生） | **改 `node:sqlite`**（Node 24/26 无需 flag 无警告；26 上为 RC 1.2；SQLite 编进 node 二进制） | 数据层**零原生依赖**，消除最大的一块 |
| `@napi-rs/keyring` | **保留**（Node-API，ABI 跨大版本稳定，只需按平台预编译） | 每平台 1 个 `.node`；比 CLI 封装更不容易"假成功" |
| Job Object addon | **仅 Windows 加载**（`try require` 失败降级 `taskkill /T`） | macOS/Linux 上不存在 |

> `node:sqlite` 与 `better-sqlite3` 的差：无 `db.transaction()` 包装（手写 `BEGIN/COMMIT`）、
> 无 `serialize/deserialize`——本项目两者都不用。M0 开 1 天 spike 验证 WAL + `user_version` +
> 迁移序列，通过即切换；不通过则保留 `better-sqlite3`，代价只是每平台一份 prebuild。

## 9. 明确不引入（避免后来者误解）

- 不引 ORM（Prisma/TypeORM/Drizzle）——迁移顺序必须可见；Drizzle 作为只读查询层可后续评估。
- 不引 uWebSockets.js、不引 NestJS、不引 Express。
- 不引图表库（时间线自绘 SVG）、不引 dayjs/moment。
- 不引 monorepo 构建编排器（turbo/nx）——pnpm 脚本足够。
- 不引 state 框架全家桶（Redux/MobX）——Query + zustand 已覆盖。
- 不做单文件可执行打包（用户已明确不要求），因此不为它牺牲任何依赖选择。
