# TideWatch（潮录）使用手册

> 版本 `0.0.0` · 适用 M0–M5 完成态 · 最后更新 2026-10-31
>
> 本手册面向**使用者**：装好、登录、加任务、看产物、出问题时怎么查。
> 想改代码或了解设计取舍，看 [../README.md](../README.md) 与 `docs/` 下的设计文档。

---

## 目录

1. [这是什么](#1-这是什么)
2. [安装与准备](#2-安装与准备)
3. [启动与登录](#3-启动与登录)
4. [界面导览](#4-界面导览)
5. [任务：添加与管理](#5-任务添加与管理)
6. [录制过程中到底发生了什么](#6-录制过程中到底发生了什么)
7. [产物与后处理](#7-产物与后处理)
8. [设置项全表](#8-设置项全表)
9. [通知](#9-通知)
10. [Cookie 与平台登录态](#10-cookie-与平台登录态)
11. [插件](#11-插件)
12. [CLI 参考](#12-cli-参考)
13. [HTTP API 参考](#13-http-api-参考)
14. [数据、备份与迁移](#14-数据备份与迁移)
15. [安全与暴露面](#15-安全与暴露面)
16. [故障排查](#16-故障排查)
17. [FAQ](#17-faq)
18. [已知限制](#18-已知限制)

---

## 1. 这是什么

TideWatch 是一个**常驻的直播录制服务**：你给它一个直播间地址，它按固定间隔去看"开播了没"，
开播就录、下播就收尾，并把这一场合并成一个 MP4。浏览器（含手机）就是客户端，不需要装桌面程序。

一次典型的日常：

1. 打开页面 → 在「总览」粘贴 `https://live.bilibili.com/6192987`；
2. 之后你什么都不用做——开播自动录，下播自动出 MP4；
3. 想回看就点「最近一场」→ 页面里直接播放；
4. 出问题（缺依赖 / 需要登录 / 断流太久）会在「通知」里告诉你。

**它擅长**：长时间挂着不要人管、断流要能自己接上、断电或被强杀后数据别丢。

**它不擅长**：当下载器批量扒视频、转码压片、破解会员或 DRM。这些都不在范围内。

---

## 2. 安装与准备

### 2.1 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| Node.js | **≥ 24**（推荐 26.x） | 用了内置 `node:sqlite`，低版本直接跑不起来 |
| pnpm | 12.x | `packageManager` 已锁定 |
| 磁盘 | 按录制量留余量 | 一场 720p60 大约 **0.3–0.6 GB/小时** |
| 网络 | 能访问直播平台与 CDN | 公司代理环境下要摘掉 `HTTP_PROXY`（见 §16） |

ffmpeg / ffprobe **不需要手动安装**，由脚本下载到 `vendor/`，由程序自己解析（见 §2.3）。

### 2.2 首次安装

```bash
git clone <repo> && cd TideCapSev
pnpm install
pnpm -r build          # 7 个 workspace 包
pnpm fetch:ffmpeg      # 下载 ffmpeg + ffprobe 到 vendor/ffmpeg/bin
```

`pnpm fetch:ffmpeg` 的细节：

- 主源 `ffmpeg.martin-riedl.de`，备源 `evermeet.cx`（仅 macOS）；
- 按平台与架构选包（darwin/linux × amd64/arm64），已有则跳过，`--force` 重下；
- 装完写 `vendor/ffmpeg/VERSION`，`--only ffmpeg` / `--only ffprobe` 可单独补。

验证：

```bash
./vendor/ffmpeg/bin/ffmpeg -version | head -1
# ffmpeg version 9.0.2 ...
```

### 2.3 二进制怎么被找到（三级解析）

程序按这个顺序找 ffmpeg / ffprobe，**先命中先用**：

1. 环境变量 `TIDEWATCH_FFMPEG` / `TIDEWATCH_FFPROBE`（绝对路径，最高优先级）；
2. 随包 `vendor/ffmpeg/bin/`；
3. 系统 `PATH`。

「设置 → 运行环境」会把**版本**和**来源**（环境变量 / 随包 vendor / 系统 PATH）都标出来。
走系统 PATH 时来源徽标是琥珀色的，意思是**版本不受控**——而 ffmpeg 的 stderr 措辞会随版本变，
错误分类靠关键词表，所以同一份流可能被归到不同错误码。除非你清楚在做什么，否则让它用 vendor 的。

> 静态编译的 ffmpeg 不带系统 CA 路径，服务端会自动注入 `SSL_CERT_FILE`
> （`/etc/ssl/cert.pem`、`/etc/ssl/certs/ca-certificates.crt`、`/etc/pki/tls/certs/ca-bundle.crt`）。
> 少了这步，对任何 https 源都会 `certificate verify failed`，而录制侧只表现为"无限重连"。

### 2.4 插件（可选但大多数情况需要）

抖音 / B 站的抓流靠 `plugins/streamget-plugin`（Python）。它需要：

- Python **≥ 3.10**（优先 `vendor/python/bin/python3`，否则 PATH 上的 `python3`）；
- 依赖已随 `site-packages/` 一起分发；若缺失，按 `requirements.lock` 重装。

装好启动后，「设置 → 插件」应看到：

```
streamget  v0.2.0  协议 2  douyin  bilibili
/…/plugins/streamget-plugin
```

看不到或标红「不可启动」，先看 §16 的插件相关条目。

---

## 3. 启动与登录

### 3.1 启动

```bash
node packages/server/dist/cli.js serve
```

启动横幅（这才是权威信息，别去猜）：

```
  TideWatch daemon 已启动  (pid 56314)
  数据根     /Users/you/TideCapSev/data
  本机访问   http://127.0.0.1:8686
  局域网访问 http://10.0.0.20:8686
  访问 token 9bb2f9d5…
```

常用参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `-p, --port` | `8686` | 端口 |
| `-H, --host` | `0.0.0.0` | 监听地址；只想本机用写 `127.0.0.1` |
| `-d, --data-root` | 仓库根的 `data/` | token、数据库、录制产物都在这里 |

**数据根不跟当前目录走**：只要能认出这是仓库（根 `package.json` 名字是 `tidewatch-daemon`），
无论从哪个目录启动都指向仓库根的 `data/`；脱离仓库的形态（全局安装、单目录分发）才退回 `./data`。
也可以用 `TIDEWATCH_DATA_ROOT` 或 `-d` 显式指定。

> 同一个数据根**只能起一个 daemon**。重复启动会打印「引擎租约被占用」并以退出码 2 结束，
> 这是刻意的——两个进程同时写同一批分段会把数据搞坏。

开发模式（改代码热更新）：

```bash
pnpm dev      # 服务端 tsx watch，:8686
pnpm dev:ui   # Vite dev server :5180，/api 反代到 8686
```

### 3.2 拿到 token

token 是**首次启动自动生成的 32 字节 hex**，写在 `<数据根>/auth-token.txt`（权限 0600），
之后每次启动只加载、**不会轮换**。四个来源任选：

| 场景 | 做法 |
|---|---|
| 前台启动 | 看启动横幅最后一行 |
| 后台 / 服务化，没有终端 | `node packages/server/dist/cli.js token`（可加 `-d <数据根>`） |
| 只想直接看 | `cat <数据根>/auth-token.txt` |
| 想用自己记的口令 | **首次启动前**写入该文件即可，程序会读它而不是生成 |

自选 token 示例（长度不限，建议 ≥ 32 位）：

```bash
printf '%s\n' 'my-own-secret' > data/auth-token.txt
chmod 600 data/auth-token.txt
```

### 3.3 登录

打开 <http://127.0.0.1:8686>，粘贴 token。登录成功后服务端下发 HttpOnly cookie `tw_session`：

- 有效期 **7 天**，并且**每次使用都会续期**（一直在用就不会掉）；
- token 本身可以给多台设备用，各自拿各自的 cookie；
- **daemon 重启后**内存里的会话表清空，所有设备要重新粘一次 token（token 不变）；
- 登录接口限速 **5 次/分钟**，写错几次会被临时拦住，等一分钟即可。

### 3.4 换 token

```bash
# 正确顺序：先停，再删，再启动
node packages/server/dist/cli.js stop
rm data/auth-token.txt
node packages/server/dist/cli.js serve     # 会生成新的并打印
```

反例（会卡很久）：daemon 还在跑的时候删了文件。这时 `tidewatch token` 会**另生成一份**新文件，
而进程手里是旧 token，粘新的只会 401，直到重启才恢复。CLI 现在会在这种情况下提醒你：
「8787 端口上的 daemon 仍在用旧 token，重启后这个新 token 才会生效。」

---

## 4. 界面导览

顶栏右侧是「通知」铃铛（带未读数），侧栏是四个入口：**总览 / 任务 / 录制 / 设置**，手机端是底部 Tab。
侧栏在宽屏上**钉在视口里**，右侧内容再长也不会把它顶出屏幕。

界面的分工是一句话：**总览看状态，任务管全量，录制看历史。**

### 4.1 总览

| 区域 | 内容 |
|---|---|
| 四张统计卡 | 服务版本 / 引擎是否运行 / 磁盘可用 / 今日录制总时长 |
| 添加直播间 | 输入框 + 「添加」，支持直播间页、`b23.tv`、`.m3u8` 直链 |
| 最近任务 | 最多 6 个，录制中的排最前；右上角「全部 N 个 →」进任务页 |
| 最近录制 | 最近 6 场，点开进详情 |

房间多了以后总览的高度是**固定的**（统计 + 添加 + 6 条 + 6 条），不会随着任务数量无限变长；
超出 6 条的部分只在「任务」页出现。

### 4.2 任务

全量任务列表，按状态分组：**正在录制 / 需要处理 / 监控中 / 已暂停**（组内按最近活动倒序）。
每行显示：状态徽标、主播名、标题、单行详情、上一场（可点进会话）、画质与分段时长。

| 控件 | 作用 |
|---|---|
| 搜索框 | 匹配主播名 / 标题 / 地址 / 平台 key，输入即筛 |
| 状态筛选 | 全部 / 录制中 / 需处理 / 监控中 / 已暂停，后面的数字是各档数量 |
| 监控开关 | 这一行是否按间隔轮询 |
| 开始录制 / 停止录制 | 只影响当前这一场，见 §5.2 |
| 检查 | 立即去看一次开播状态 |
| 设置 | 画质、分段、后处理、单场上限；**删除任务**也在这个弹窗里 |

搜索框与筛选条在滚动时**钉在顶部**，列表再长也不用滑回顶部才能改条件。

几个交互细节：

- **重复添加**不会报"失败"：服务端返回 409 并带上已有任务 id，页面显示蓝字提示并把那一行标出来
  （新加的这条如果搜索条件挡住了，会自动清空筛选让你看见它）。
- **停止录制**不等于关监控：它把"本场"标成跳过（`本场已跳过`），下一次开播照样录。
- **删除任务**会让它的会话索引一并消失，**但磁盘上的视频不删**。要留历史就只关监控。

### 4.3 录制（会话列表）

按任务筛选，每行是一场：主播名 + 结束原因 + 时间区间 + 时长 + 段数，右侧是结束原因文案。
点任意一行进会话详情。

### 4.4 会话详情

从上到下：

1. **头部**：主播名、起止时间、「← 返回」「重新合并」；
2. **徽标行**：是否录制中 / 承接上一场 / 总时长 / 段数 / 总大小；
3. **产物**：内置播放器（支持 Range 拖动，只允许播放录制目录内的文件）+ 文件名、时长、大小；
4. **时间轴**：每段一个色块，斜纹表示缺口，红线是中断事件（卡死硬杀、放弃重连、解析失败、stderr 分类）；
5. **分段表**：序号、开始时间、时长、大小、画面（分辨率 + 编码）、完整性；
6. **事件**：这一场所有事件的流水（`session.started`、`recording.segment`、`recording.gap`…），
   长 JSON 会省略号截断，鼠标悬停可看整行。

时间轴颜色含义：

| 颜色 | 含义 |
|---|---|
| 绿色 | 完好 |
| 琥珀 | 尾部截断 / 被中断 / 孤儿 |
| 蓝色 | 崩溃抢救（进程被杀后恢复出来的） |
| 灰色 | 源已清理 |

### 4.5 设置

见 §8 全表。分五块：录制默认值、通知渠道、插件、平台 Cookie、运行环境。

### 4.6 通知面板

点铃铛从右侧滑出：未读数、每条通知的级别与时间、能关联到会话的给「查看这场」。
「全部已读」清空未读角标。通知只是**账本 + 提示**，不影响录制。

### 4.7 手机上用

同一个局域网直接开 `http://<电脑IP>:8686`，登录一次即可。窄屏下侧栏变成底部 Tab，
所有页面在 320–1440 宽度都没有横向滚动条。

---

## 5. 任务：添加与管理

### 5.1 添加

在「总览」或「任务」页粘贴地址 → 「添加」（输入框里直接回车也行）。服务端会先做一次**探测**（外网请求，可能要几秒）：

- 成功：任务入库、状态 `等待开播`，随后引擎开始按间隔轮询；
- 重复：`409`，页面提示并高亮已有任务；
- 探测卡住：60 秒超时并提示，任务**可能**已经建好，列表会自动刷新。

支持的地址形态：`live.douyin.com/…`、`v.douyin.com/…`、`www.douyin.com/user/…`、
`live.bilibili.com/…`、`bilibili.com/video/…`、`b23.tv/…`、任意 `.m3u8` 直链。

### 5.2 三个开关（理解这个就理解了一半的用法）

| 开关 | 含义 | 由谁改 |
|---|---|---|
| 监控 `monitor_enabled` | 要不要按间隔去看开播 | 任务行的「监控」开关 |
| 录制请求 `record_requested` | "我要录"的意愿 | 「开始录制」= true；「停止录制」= false |
| 跳过本场 `skip_current_live` | 这一场别录，下一场照常 | 点「停止录制」时自动置 true |

所以「停止录制」之后状态是 `本场已跳过`，而不是"未监控"；主播下次开播仍然会录。
想彻底不录，关掉「监控」。

「立即检查」= 不等下一个轮询周期，马上看一次（`check_now`）。

### 5.3 任务设置（点任务行上的「设置」）

| 字段 | 默认 | 范围 | 何时生效 |
|---|---|---|---|
| 画质 | 平台默认 | 由插件解释（如 `原画` / `OD`） | 下一次开录 |
| 分段时长 | 1800 秒 | 30–43200 | 下一次开录 |
| 后处理 | 合并成一个 MP4 | merge / per_segment / manual | 收尾时读取，**录到一半改也有效** |
| 单场时长上限 | 0（=6 小时） | 0 或 600–21600 | 即时 |
| 单场体积上限 | 0（=20 GiB） | 0 或 1 MiB–100 GiB | 即时 |

> 「画质」是字符串，具体取值由插件决定。B 站匿名状态下只有 `超清`（720p60）一档，
> 想要原画得先配 Cookie（§10）。

单场上限到了会怎样：当前场按 `capped` 结束并开始合并，然后**自动开新的一场承接**下去
（详情页会标「承接上一场」）。这样长时间直播不会因为一次上限而断掉整晚。

---

## 6. 录制过程中到底发生了什么

### 6.1 状态一览

| 状态 | 界面文案 | 含义 |
|---|---|---|
| `idle` | 未监控 | 监控关了 |
| `resolving` | 解析中 | 正在向插件要真实流地址 |
| `waiting` | 等待开播 | 没在播，按间隔轮询 |
| `recording` | 录制中 | 正在写分段，卡片上显示"已录 x" |
| `snoozed` | 本场已跳过 | 你在本场点了停止录制 |
| `reconnecting` | 重连中 | 流断了正在重取（detail 里是原因） |
| `finalizing` | 收尾中 | 正在 ffprobe / 合并 |
| `error` | 出错 | 见 detail 与事件 |
| `needs_auth` | 需要登录 | 这个平台要 Cookie 才能取流 |
| `needs_dep` | 缺少运行环境 | ffmpeg 或插件运行时缺失 |
| `unsupported` | 平台未支持 | 没有插件认领这个地址 |

### 6.2 一场的生命周期

1. `session.started`：开录，目录 `<主播>/<YYYYMMDD-HHMMSS>_<new|cap>_<taskId8>/` 建好；
2. 每 `分段时长` 秒切一个 `partNNN.ts`，**每段落盘后才记账**（manifest 是事实源，数据库只是索引）；
3. 断流：`recording.gap` 记缺口，按退避重连，接上后继续写下一段；
4. 收尾：`session.ended`（结束原因见下）→ `finalizing` → 合并 → 产物入库 → 通知。

结束原因：

| 原因 | 界面文案 | 什么时候出现 |
|---|---|---|
| `offline` | 下播结束 | 正常下播 |
| `manual` | 手动停止 | 你点了停止录制 |
| `error` | 异常结束 | 连续失败、解析失败等 |
| `disk` | 磁盘错误 | 写盘失败 / 空间不足 |
| `degraded` | 连续失败降级 | 重连放弃后主动收尾 |
| `capped` | 到达单场上限 | 时长或体积到顶（会承接下一场） |
| `interrupted` | 进程中断（已恢复） | daemon 被强杀后，下次启动恢复出来 |
| `shutdown` | 服务退出 | 优雅停止时正在录 |

### 6.3 被强杀也不丢

daemon 启动时会做一次**恢复扫描**：读每个会话目录里的 manifest 与磁盘上的分段，比对之后

- 有 manifest 但没正常收尾的段 → 标 `truncated` / `recovered`（崩溃抢救，时间轴上蓝色）；
- 磁盘上有、索引里没有的文件 → 标 `orphan`（孤儿文件）；
- 索引里有、磁盘上没有的 → 记为缺失。

日志里一行就能看到结果：

```
[tidewatch] 恢复扫描完成 { interrupted: 0, recovered: 0, orphaned: 0, missing: 0 }
```

恢复出来的场次会继续走合并流程——这就是"kill -9 之后还能出 MP4"的原因。

### 6.4 磁盘保护

- 合并后默认清理中间文件（`.fixed.ts`、concat 清单），**源 TS 永不自动删除**；
- 「总览」的磁盘可用量是实时的；写盘失败会以 `disk` 结束当前场，不会静默丢数据；
- 想省空间：把「合并后清理中间文件」打开（默认已开），或手动删旧的 `_partNNN.ts`。

---

## 7. 产物与后处理

### 7.1 目录结构

```
<录制目录>/<主播>/20261031-093433_new_a2d80a46/
    央视频_20261031_093433.mp4         合并产物
    a2d80a46…_part001.ts …             源分段（编号三位，按顺序）
    session.manifest.json              这一场的事实源（分段顺序、指纹、事件）
```

- 目录名里的 `new` / `cap`：`cap` 表示它是被上限切断后承接出来的下半场；
- 分段文件名前缀是 taskId，同一场即使跨重启也保持编号连续。

### 7.2 后处理策略

| 策略 | 结果 | 适用 |
|---|---|---|
| `merge`（默认） | 一场一个 MP4 | 想直接看/上传 |
| `per_segment` | 每段一个 MP4 | 只想留片段、不想等合并 |
| `manual` | 只落 TS，等你手动「重新合并」 | 想自己决定什么时候合 |

「重新合并」在会话详情右上角，任何时候都能点（幂等：重复点不会重复产出垃圾）。

### 7.3 faststart

`faststart` 决定 moov 是否前置（影响"边下边播"和拖动响应）：

- `auto`（默认）：源总量小于阈值（默认 512 MB）才重写 moov；
- `on`：总是开启（文件会整体重写一遍，慢）；
- `off`：不处理。

---

## 8. 设置项全表

| 设置 | 默认 | 范围 | 谁在读、何时生效 |
|---|---|---|---|
| 轮询间隔 | 30 s | 5–3600 | 引擎；**重启生效** |
| 分段时长 | 1800 s | 30–43200 | 新开场的任务；任务级可覆盖 |
| 默认后处理 | merge | merge / per_segment / manual | 新建任务时的初值 |
| faststart | auto | auto / on / off | 收尾合并时 |
| faststart 阈值 | 512 MB | 1–102400 | `auto` 模式下判断 |
| 合并后清理中间文件 | 开 | 布尔 | 收尾清理时；**只删中间件，不动源 TS** |
| 通知渠道 | 全关 | 见 §9 | 事件发生时 |
| 录制目录 | 空（= `<数据根>/downloads`） | 绝对路径 | **重启生效** |

保存时界面会告诉你哪些已经生效、哪些要重启。

「运行环境」这块不是设置，而是**事实展示**：数据根、录制目录、ffmpeg/ffprobe 的版本与来源、
python、Cookie 存储后端（`keychain` 或 `plaintext-file`）、磁盘可用、引擎租约是否持有。
「导出诊断包」会把版本、二进制来源、租约、最近事件与统计写成一个 `.md` 到 `<数据根>/exports/`
（不含 cookie 明文），排障时优先给这个。

---

## 9. 通知

### 9.1 规则

- **只有 `warn` / `error` 会外发**；`info` 只进铃铛（正常进展弹推送会把人训练成不看了）；
- 同一 `(类别, 任务)` 在 **10 分钟内只推一次**（否则一轮轮询就能刷上百条）；
- 单个渠道失败只写审计日志，不影响其他渠道，也不影响录制。

会外发的类别：`recording_ended`（异常收尾）、`merge_failed`、`needs_auth`、`needs_dependency`、
`platform_unsupported`、`session_capped`，以及 `recording_started` / `merge_completed` 等按级别判定。

### 9.2 渠道

| 渠道 | 必填 | 备注 |
|---|---|---|
| ntfy | 服务器（默认 `https://ntfy.sh`）、topic | 可填 token；自建服务器也行 |
| Bark | 服务器（默认 `https://api.day.app`）、Device Key | iOS |
| Telegram | Bot Token、Chat ID | 需要能访问 api.telegram.org |
| 邮件 SMTP | host、端口、用户名、密码、发件人、收件人 | 465 用 SSL 直连；587 用 STARTTLS |
| Web Push | 先「生成 VAPID 密钥」，再在浏览器订阅 | **需要 HTTPS 或 Tailscale Serve**，http 下浏览器不给订阅 |

每个渠道都有「发送测试」，先点它确认通了再依赖它。

---

## 10. Cookie 与平台登录态

用途：某些平台（或某些画质档位）必须带登录态才能取流。B 站匿名只到 720p60，原画要 Cookie。

操作：「设置 → 平台 Cookie」→ 平台 key（小写，如 `douyin` / `bilibili`）→ 粘贴 Cookie 字符串 → 保存。

几个纪律：

- Cookie **只出服务端、不回显明文**，接口只返回掩码与更新时间；
- 存储优先系统钥匙串；钥匙串不可用时降级为 `<数据根>/credentials.json`（0600），
  界面会**如实**标「未加密」——不会出现"看起来加密其实没有"；
- 过期了就是过期了：任务会进 `needs_auth`，配好新 Cookie 后点「立即检查」即可恢复。

取 Cookie 的通用方法：在浏览器登录该平台 → 开发者工具 → Network → 任一请求的
`Cookie` 请求头整串复制。别用无痕窗口取的（关掉就失效）。

---

## 11. 插件

插件负责"给我这个地址的真实流地址"。协议是 **stdio JSON**（`protocol: 2`），
支持 `oneshot`（每次启动一次）与 `serve`（常驻）两种模式。

发现顺序：`<数据根>/plugins/` 优先，`<资源根>/plugins/` 兜底。同名插件高版本生效，
被压住的版本会在「设置 → 插件」里标「被遮蔽」。

内置 `streamget` 覆盖：

| 平台 | 地址形态 |
|---|---|
| 抖音 | `live.douyin.com/…`、`v.douyin.com/…`、`www.douyin.com/user/…` |
| B 站 | `live.bilibili.com/…`、`bilibili.com/video/…`、`b23.tv/…` |

清单字段（`plugin.json`）：`name` / `version` / `protocol` / `exec` / `args` / `env` /
`modes` / `url_patterns` / `platforms` / `requires`。`exec` 里的 `{python}`、`{node}`、
`{plugin_dir}` 会被替换成实际路径。

改完插件点「重新扫描」，不用重启 daemon。

---

## 12. CLI 参考

命令前缀统一是 `node packages/server/dist/cli.js`（全局安装后可直接 `tidewatch`）。

| 命令 | 参数 | 说明 |
|---|---|---|
| `serve` | `-p`、`-H`、`-d` | 唯一常驻形态；默认 8686 / 0.0.0.0 |
| `status` | `-p` | 打印 `/api/health` 的 JSON |
| `stop` | `-p`、`-d` | 优雅停止：等收尾 → 超时硬杀 → 恢复扫描 |
| `token` | `-d`、`-p` | 打印 token；若刚生成且同数据根的 daemon 在跑，会提醒需重启 |
| `add <url>` | `-p`、`-d`、`--no-monitor` | 命令行加任务 |
| `record <taskId>` | `-p`、`-d`、`--stop` | 手动录 / 停当前场 |
| `diagnose` | `-p`、`-d` | 导出诊断包，返回路径 |
| `service <install\|uninstall\|status>` | `-d`、`-p` | 开机自启：launchd `com.tidewatch.daemon` / systemd `--user tidewatch.service` / Windows 登录计划任务 |

CLI 的写操作会自动读 token 换 cookie，所以**必须在同一个机器上执行**（token 不出本机）。

冒烟/巡检脚本：

```bash
node tools/smoke.mjs --port 8686 --data ./data          # 7 项断言
node tools/smoke.mjs --port 8686 --data ./data --shutdown
```

---

## 13. HTTP API 参考

所有 `/api/*` 默认要登录（cookie `tw_session`）；**写操作**还必须带 `X-TideWatch-Client: 1`，
否则 403 `csrf`。这是故意的：防止跨站表单直接打你的服务。

| 方法与路径 | 作用 |
|---|---|
| `GET /api/health` | 版本、平台、schema、引擎、租约、路径、磁盘、二进制状态 |
| `POST /api/auth/login` | `{token}` → 下发 cookie（限速 5/min） |
| `GET /api/auth/session` | 当前会话是否有效 |
| `POST /api/auth/logout` | 清 cookie |
| `GET /api/tasks` · `POST /api/tasks` | 列表 / 新建（重复 → 409 + `taskId`） |
| `PATCH /api/tasks/:id` | 改画质、分段、后处理、单场上限 |
| `DELETE /api/tasks/:id` | 删任务（级联删会话索引，不删磁盘文件） |
| `POST /api/tasks/:id/monitor` | `{enabled}` 监控开关 |
| `POST /api/tasks/:id/record` | `{recording:true\|false}` 开始/停止本场 |
| `POST /api/tasks/:id/check` | 立即检查 |
| `GET /api/tasks/:id/sessions` | 该任务的会话列表 |
| `GET /api/limits` | 单场上限常量（UI 不写死） |
| `GET /api/sessions` | 会话列表；`?limit=&task=&segments=1` |
| `GET /api/sessions/:id` | 详情（含 segments / artifacts） |
| `GET /api/sessions/:id/events` | 事件流水 |
| `POST /api/sessions/:id/merge` | 重新合并 |
| `GET /api/events` | 全局事件（`?since=&limit=`） |
| `GET /api/videos?path=` | 播放产物（支持 Range，限制在录制目录内） |
| `GET /api/notifications` · `POST /api/notifications/read` | 通知列表 / 全部已读 |
| `GET /api/settings` · `PUT /api/settings` | 全局设置（含 paths / runtime） |
| `POST /api/settings/notify/test` | `{channel}` 发送测试 |
| `POST /api/settings/webpush/vapid` | 生成 VAPID 密钥 |
| `GET /api/plugins` · `POST /api/plugins/refresh` | 插件列表 / 重新扫描 |
| `GET /api/cookies` · `PUT/DELETE /api/cookies/:platform` | Cookie 管理（只回掩码） |
| `GET /api/diagnostics` · `POST /api/diagnostics/export` | 诊断信息 / 导出诊断包 |
| `POST /api/shutdown` | 优雅停止（202 先回，再收尾） |
| `GET /api/ws` | WebSocket 事件流（无 cookie 升级直接 401；25s 心跳） |

curl 模板（cookie 罐 + CSRF 头）：

```bash
BASE=http://127.0.0.1:8686
TOKEN=$(cat data/auth-token.txt)
curl -sS --noproxy '*' -c /tmp/tw.jar -X POST $BASE/api/auth/login \
  -H 'content-type: application/json' -H 'X-TideWatch-Client: 1' \
  -d "{\"token\":\"$TOKEN\"}"
curl -sS --noproxy '*' -b /tmp/tw.jar $BASE/api/tasks
```

状态码约定：`400` 参数不合法、`401` 未登录、`403` 缺 CSRF 头 / 路径越界、`404` 不存在、
`409` 重复任务（带 `taskId`）、`429` 限速（带 `retryAfter`）。

---

## 14. 数据、备份与迁移

必须备份的：

| 文件 | 为什么 |
|---|---|
| `<数据根>/tidewatch.db`（含 `-wal`、`-shm`） | 任务、会话、分段索引、通知、审计全在这 |
| `<数据根>/auth-token.txt` | 不备份也行，删了会重新生成（但要重新登录） |
| `<数据根>/credentials.json` | 仅在钥匙串不可用时存在（Cookie 明文，注意权限） |
| `<录制目录>/…/*.mp4` | 你的视频 |

不用备份的：`vendor/`（`pnpm fetch:ffmpeg` 重下）、`node_modules/`、`plugins/*/site-packages/`。

迁移到新机器：

```bash
# 旧机
node packages/server/dist/cli.js stop
rsync -a data/ newhost:/srv/tidewatch/data/
# 新机
pnpm install && pnpm -r build && pnpm fetch:ffmpeg
node packages/server/dist/cli.js serve -d /srv/tidewatch/data
```

tsx/Node 版本一致时不用动数据库；schema 由内置迁移自动升级（`/api/health` 里的 `schemaVersion`）。

---

## 15. 安全与暴露面

- **token 是唯一门槛**：能访问这个端口的人就能删你的录制、改你的设置。别把 8686 直接挂公网。
- 推荐做法：`-H 127.0.0.1` 只监听本机，前面放 nginx / Caddy / Tailscale Serve 做认证与 TLS。
- 走 HTTPS 反代时设 `TIDEWATCH_SECURE_COOKIE=1`（cookie 加 `Secure`），否则跨站场景 cookie 会被丢。
- 写操作要 `X-TideWatch-Client: 1`（CSRF 兜底）；登录限速 5/min。
- `/api/videos` 只允许读录制目录内的文件（防目录穿越）。
- Cookie 存钥匙串；降级明文时会明说"未加密"。
- 日志与诊断包**不含** token 与 cookie 明文。

---

## 16. 故障排查

| 现象 | 多半是 | 动作 |
|---|---|---|
| 页面能开，但接口全 401 | token 来自另一个数据根 | 看启动横幅的「数据根」，`cat <它>/auth-token.txt`；或统一用 `-d` |
| 粘 token 一直 401，日志里能登录成功 | 你在运行中删过 token 文件 | 重启 daemon（CLI 现在会提示这一点） |
| 任务卡在 `needs_dep` | ffmpeg / python 找不到 | 「设置 → 运行环境」看来源；`pnpm fetch:ffmpeg`；或 `TIDEWATCH_FFMPEG` |
| 一直 `reconnecting`，detail 是 `stream_eof` | 证书 / 请求头 / 流地址过期 | 手工验：`./vendor/ffmpeg/bin/ffmpeg -v error -t 5 -i <url> -f null -`；`certificate verify failed` → 查 `SSL_CERT_FILE` |
| 一直 `重连中`，但录制其实在跑 | 反代掐了 WebSocket | 直连 8686 试；DevTools 看 `/api/ws` 是否 101 |
| 页面白屏 / 资源 404 | 只 `pnpm build` 了部分包 | `pnpm -r build`，确认 `packages/ui/dist/index.html` 存在 |
| `curl` 写操作 403 `csrf` | 少了 CSRF 头 | 加 `-H 'X-TideWatch-Client: 1'` |
| 启动直接退出，日志「引擎租约被占用」 | 同一数据根起了两个 daemon | `pgrep -fl 'cli.js serve'`，停掉一个（退出码 2 就是它） |
| 端口占用 `EADDRINUSE` | 上一个没退干净 | `lsof -i :8686` 后 kill，或换 `--port` |
| 停止录制没反应 | body 字段写错 | 必须是 `{"recording":false}` |
| 添加时一直转「解析中…」 | 插件探测卡住 | 60 秒会超时；看 `GET /api/plugins` 的 `error` |
| 删任务后历史也没了 | 既有行为：级联删会话索引 | 磁盘视频还在；要留历史就只关监控别删任务 |
| `error_class` 分类和实际不符 | 用了系统 PATH 上的 ffmpeg | 换成 vendor 的（版本不受控会改变 stderr 措辞） |
| 录出来没有声音 | 源本身无音轨 / 编码不支持 | 看分段表的音频信息；`ffprobe` 复核源 |
| 通知收不到 | 渠道没启用 / 只发 warn·error | 点「发送测试」；`info` 级别不外发是设计 |
| 公司网络下插件探测失败 | 代理绕到了 `HTTP_PROXY` | 启动时 `env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy …` |

要证据就导诊断包：「设置 → 导出诊断包」，或 `node … cli.js diagnose`。

---

## 17. FAQ

**Q：能不能同时录多个直播间？**
能。每个任务一条轮询线，互不干扰；并发上限受磁盘与带宽约束，不是软件限制。

**Q：能不能录完自动传到网盘 / NAS？**
当前不做。产物就在录制目录，用系统的同步工具（rsync / Syncthing / 群晖 Drive）挂上去即可。

**Q：怎么让一场录少一点？**
把分段时长调小（30 秒最细），或把「合并后清理中间文件」开着；单场限制也可以按任务调。

**Q：为什么分段是 `.ts` 而不是 `.mp4`？**
TS 是流式容器，进程被杀时最多损失最后一个不完整段；MP4 落盘中途被杀会整段损坏。
所以录制用 TS，收尾再合并成 MP4。

**Q：能不能改端口 / 只给本机用？**
`-p 9000`、`-H 127.0.0.1`。改了端口记得同步反代配置。

**Q：支持哪些平台？**
目前插件覆盖抖音、B 站；任意 `.m3u8` 直链也能录。其它平台需要写插件。

**Q：升级会不会丢数据？**
不会。数据库迁移是幂等的，`pnpm -r build` 后重启即可；建议升级前备份 `tidewatch.db`。

**Q：录制会不会影响主播？**
它只是按平台公开接口取流，和你在浏览器里看直播是同一类请求，不会给直播间加人数。

---

## 18. 已知限制

- **画质协商**：匿名只到 720p60；`quality_options` 目前只报一个可选档位，原画要登录 Cookie。
- **登录态在内存里**：daemon 重启后所有设备要重新粘一次 token（token 本身不变）。
- **删除任务级联删索引**：磁盘视频保留，但会话详情会消失。
- **通知不重试**：渠道失败只写审计日志。
- **没有 Docker / brew / 反代示例**：`deploy/` 目录仍是占位（M6）。
- **单实例**：一个数据根只能跑一个 daemon（引擎租约保证），不支持多进程分片。
- **平台验收不均**：主机适配层按 darwin / linux / win32 都写了分支，但服务注册（launchd / systemd / schtasks）
  只在 macOS 上验证过 install 流程，另外两个分支尚未真机验收。
