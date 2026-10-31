# 真机测试手册

> 面向"把 daemon 跑起来、用浏览器真录一场"的人。自动化用例覆盖逻辑，这份手册覆盖**只有真机能验证的东西**：
> 平台抓流、ffmpeg 实际出流、断网/强杀这类故障、手机与反代。
> 配套矩阵见 `docs/test-matrix.md` §6（本文是它的可执行版本）。

## 0. 一句话结论

| 问题 | 答案 |
|---|---|
| 现在能真机测吗 | **能**。B 站已跑通一次完整录制（154.4s / 47.5MB → mp4），其余 7 项待跑 |
| 有页面操作吗 | **有**。daemon 自带 SPA，浏览器打开 `http://127.0.0.1:8686` 即可，无需另起前端 |
| 需要什么外部依赖 | 只有 **ffmpeg/ffprobe**；由 `pnpm fetch:ffmpeg` 装到 `vendor/`，不装系统 PATH 也行 |
| 能不能纯命令行测 | 能，见 §4（冒烟）与 §5（curl 配方） |

## 1. 准备（一次性）

```bash
# 仓库根目录
node -v            # 需 >= 24（本机通过 nvm 是 26.13.0）
pnpm -v            # 12.x
pnpm install
pnpm -r build      # 8 个包，约 10s
pnpm fetch:ffmpeg  # 下载 ffmpeg + ffprobe 到 vendor/ffmpeg/bin（已存在则跳过）
```

确认二进制：

```bash
./vendor/ffmpeg/bin/ffmpeg -version | head -1
# ffmpeg version 9.0.2 Copyright (c) ...
```

> `vendor/` 已在 `.gitignore` 里（180MB，属"层 B 平台相关件"）。换机器要重跑 `pnpm fetch:ffmpeg`。
> 有系统 ffmpeg 也可以，用 `TIDEWATCH_FFMPEG=/usr/local/bin/ffmpeg` 覆盖；但**版本会改变 stderr 措辞**，
> 而错误分类靠关键词表——UI 会把"来源"标成"系统 PATH"提醒你这一条（见 §3 设置页）。

## 2. 启动 daemon

前台（推荐，日志直接看得见）：

```bash
node packages/server/dist/cli.js serve --port 8686 --data-root ./data
```

启动横幅会打印数据根、本机地址、**局域网地址**和访问 token：

```
  TideWatch daemon 已启动  (pid 56314)
  数据根     /Users/richard/Develop/TideCapSev/data
  本机访问   http://127.0.0.1:8686
  局域网访问 http://10.0.0.20:8686
  访问 token 9bb2f9d5…
```

| 参数 / 变量 | 作用 |
|---|---|
| `--port` / `-p` | 端口，默认 8686 |
| `--host` / `-H` | 监听地址，默认 `0.0.0.0`（手机能访问）；只给本机用就写 `127.0.0.1` |
| `--data-root` / `-d` | 数据根（token、sqlite、downloads 都在这里），默认 `./data` |
| `TIDEWATCH_FFMPEG` / `TIDEWATCH_FFPROBE` | 指定二进制绝对路径，优先级最高 |
| `TIDEWATCH_SECURE_COOKIE=1` | 走 https 反代时才开（cookie 加 Secure） |

**开发模式**（改代码热更新，两个终端）：

```bash
pnpm dev      # 服务端 tsx watch，8686
pnpm dev:ui   # Vite dev server，5180，/api 反代到 8686
```

> 如果机器上设了 `HTTP_PROXY`（公司代理、Agent 沙箱等），启动时先摘掉，
> 否则 ffmpeg/插件的出网请求会绕到代理上：
> `env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy node packages/server/dist/cli.js serve ...`

## 3. 打开页面

浏览器访问 <http://127.0.0.1:8686>，粘贴 token 登录（token 有三个来源，任选）：

```bash
cat data/auth-token.txt                                  # 文件
node packages/server/dist/cli.js token -d ./data         # CLI 打印
# 或看启动横幅那一行
```

登录后是 HttpOnly cookie（`tw_session`，7 天滚动），刷新不掉；侧边栏底部显示**实时连接**绿灯，
说明 WS 事件流已建立（断线会自动重连，状态变灰）。

### 页面地图

| 页面 | 地址 | 能做什么 | 对应验收项 |
|---|---|---|---|
| **总览** | `/` | 加直播间（抖音/B站/m3u8 直链）、任务卡片上的「开始/停止录制」「立即检查」「编辑」「详情」「删除」、服务/引擎/磁盘/今日录制四张卡 | §5.1 §5.2 §5.5 |
| **录制** | `/#/recordings` | 全部会话列表，可按任务筛选；`承接上一场`「已合并」「录制中」徽标 | §5.5 |
| **会话详情** | `/#/session/<id>` | 产物播放器、**时间轴**（段色块四态 + 缺口斜纹 + 中断竖线 + 图例）、分段表（大小/画面/完整性）、事件流、「重新合并」 | §5.3 §5.4 |
| **设置** | `/#/settings` | 轮询间隔/分段时长/后处理策略/faststart 阈值、五个通知渠道（含「发送测试」）、插件列表、平台 Cookie、**运行环境**（ffmpeg/ffprobe 版本与来源徽标）、导出诊断包 | §5.7 |

**手机访问**：手机与机器同一 Wi-Fi，打开启动横幅里的「局域网访问」地址。
macOS 首次会弹防火墙许可，允许即可；页面在窄屏切换成底部标签栏，时间轴横向不溢出。

## 4. 无浏览器冒烟（30 秒确认"服务是活的"）

```bash
node tools/smoke.mjs --port 8686 --data ./data
```

实际输出：

```
✓ health 可公开访问 — schema v12 · 租约持有
✓ ffmpeg / ffprobe 就绪 — ffmpeg 9.0.2(vendor) · ffprobe 9.0.2(vendor)
✓ 未登录访问接口返回 401 — 401
✓ token 登录拿到会话 cookie — tw_session 已下发
✓ 带 cookie 读任务列表 — 1 个任务
✓ 写操作缺 CSRF 头返回 403 — 403
✓ WS 事件流需要会话（无 cookie 被拒） — 升级被拒

全部通过
```

加 `--shutdown` 会在跑完后优雅停掉 daemon（等价于点页面上的停止，或 `POST /api/shutdown`）。
这条命令只验控制面，**不触发录制**。

## 5. 真机验收逐条

通用准备（每条都用到）：

```bash
PORT=8686
BASE=http://127.0.0.1:$PORT
TOKEN=$(cat data/auth-token.txt)
curl -sS --noproxy '*' -c /tmp/tw.jar -X POST $BASE/api/auth/login \
  -H 'content-type: application/json' -d "{\"token\":\"$TOKEN\"}"
```

> 所有**写操作**都要带 `-H 'X-TideWatch-Client: 1'`，否则 403（这是 CSRF 闸，浏览器端自动带）。

### 5.1 B 站短录（已通过，复验用）

页面路径：总览 → 输入 `https://live.bilibili.com/<房间号>` → 添加 → 任务卡片「开始录制」。
或命令行：

```bash
curl -sS --noproxy '*' -b /tmp/tw.jar -X POST $BASE/api/tasks \
  -H 'content-type: application/json' -H 'X-TideWatch-Client: 1' \
  -d '{"url":"https://live.bilibili.com/5050","monitor":true}'
# 记下返回的 task.id，然后
curl -sS --noproxy '*' -b /tmp/tw.jar -X POST $BASE/api/tasks/<taskId>/record \
  -H 'content-type: application/json' -H 'X-TideWatch-Client: 1' -d '{"recording":true}'
# 录 2 分钟后停（注意字段是 recording，不是 on）
curl -sS --noproxy '*' -b /tmp/tw.jar -X POST $BASE/api/tasks/<taskId>/record \
  -H 'content-type: application/json' -H 'X-TideWatch-Client: 1' -d '{"recording":false}'
```

通过判据：

- 任务状态 `waiting → recording`，事件流出现 `recording.segment_start`；
- `data/downloads/<主播>/<日期_时间>_new_<id>/part001.ts` 持续变大；
- 停止后出现 `merge.started` → `merge.completed`，产物 **先 `.tmp-` 再 rename**；
- 会话详情：时间轴绿色占满、分段表「完整性 完好」、产物能播放；
- `ffprobe` 复核产物：

```bash
./vendor/ffmpeg/bin/ffprobe -v error -show_entries format=duration,size \
  -show_entries stream=codec_name,width,height -of default=noprint_wrappers=1 <产物.mp4>
```

2026-10-29 实测：154.4s / 47.5MB 单段 TS → 44.6MB mp4，h264+aac 1280×720@60，`end_reason=manual`，源 TS 保留。

已知限制：匿名访问该房间只协商到 `qn=250 超清`（720p），原画需要平台 Cookie（设置 → 平台 Cookie）。

### 5.2 抖音短录（验证 `-headers` 注入顺序）

```bash
curl -sS --noproxy '*' -b /tmp/tw.jar -X POST $BASE/api/tasks \
  -H 'content-type: application/json' -H 'X-TideWatch-Client: 1' \
  -d '{"url":"https://live.douyin.com/<房间号>","monitor":true}'
```

与 B 站不同，抖音对 `User-Agent`/`Referer` 更敏感；判据同上，另外看一眼
`GET /api/plugins` 里 `missingRuntimes` 为空、`error` 为 null。
若解析成功但 ffmpeg 立刻 `stream_eof`，先按 §7 查"证书/请求头"两栏，不要先怀疑平台。

### 5.3 断网重连（缺口必须被记账，而不是静默续上）

录制中，二选一：

```bash
sudo ifconfig en0 down && sleep 30 && sudo ifconfig en0 up   # 真断网（macOS，接口名按 ipconfig getifaddr en0 确认）
pkill -f 'vendor/ffmpeg/bin/ffmpeg'                          # 只杀 ffmpeg，模拟流中断
```

通过判据：

- 任务 `reconnecting`（detail 里是错误分类，如 `stream_eof`），**不进入 `needs_dep`/失败终态**；
- 恢复后 `partNo` 递增（`part002.ts` 而不是覆盖 `part001.ts`）；
- 会话详情时间轴出现**缺口斜纹**，事件流有 `recording.gap`，缺口时长显示为具体秒数。

退避节奏是 2/5/10/30s，连续 5 次失败才降级放弃。

### 5.4 强杀恢复（进程被 `kill -9` 之后能不能救回来）

```bash
kill -9 $(pgrep -f 'packages/server/dist/cli.js serve')
node packages/server/dist/cli.js serve --port 8686 --data-root ./data   # 重新起
```

通过判据：

- 重启日志/事件里有 `recovery.*`，原会话 `state=interrupted`；
- 正在写的那一段就地标 `recovered`（能被 ffprobe 读出才算），不可解析的进 `orphan/`；
- 会话详情里该段「完整性 就地恢复」，且**可以合并**出完整产物；
- 同一份数据重复启动两次，结果不变（幂等，不能把已恢复的段再标一次）。

### 5.5 短 cap 滚动（到量必须切新场，而不是继续写）

```bash
# 段长 60s、单场体积 20MiB：约 1 分钟就能撞到 cap
curl -sS --noproxy '*' -b /tmp/tw.jar -X PATCH $BASE/api/tasks/<taskId> \
  -H 'content-type: application/json' -H 'X-TideWatch-Client: 1' \
  -d '{"segmentTimeS":60,"maxSessionBytes":20971520}'
```

通过判据：

- 事件 `session.capped`，结束原因是 `cap`；
- 「录制」页出现**第二场**，带 `承接上一场` 徽标（`origin=cap`）；
- 前一场正常合并，新一场从 `part001` 重新开始，不共用目录。

合法范围：`maxSessionS` 600..21600（0=默认 6h），`maxSessionBytes` 1MiB..100GiB（0=按默认）。

### 5.6 手机浏览器

手机打开局域网地址 → 登录 → 总览/录制/会话详情 → 点播放。
判据：底部标签栏出现、时间轴不横向溢出、视频能拖动进度条（`/api/videos` 支持 Range，返回 206）。

### 5.7 通知实际到达

设置 → 通知渠道，最快的是 ntfy：填 topic → 保存 → 点「发送测试」。
判据：

- 手机收到推送；
- 页面右上铃铛未读数 +1；
- 纪律要成立：**info 只进铃铛不推送**，只有 warn/error 才扇出到渠道；(kind, task) 10 分钟内去重。

制造一次真实 error：停掉 ffmpeg 并让解析连续失败 5 次，或把 `TIDEWATCH_FFMPEG` 指到不存在的路径后开录
（会得到 `needs_dep` + `capture.dependency_missing` 通知）。

### 5.8 反代 / 隧道

nginx 片段（关键是 `Upgrade` 与读超时）：

```nginx
location / {
    proxy_pass http://127.0.0.1:8686;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
}
```

https 场景加 `TIDEWATCH_SECURE_COOKIE=1` 再启动 daemon。
判据：页面侧边栏保持**实时连接**绿灯超过 2 分钟（服务端每 25s 发一次 `{"type":"ping"}`，
反代若有缓冲/超时会在这一步暴露：绿变灰再自己重连就是被掐了）；`/api/videos` 拖动正常。

## 6. 自动化门禁（改完代码先跑这个，再上真机）

```bash
pnpm test          # vitest：16 文件 / 132 条
pnpm lint
pnpm typecheck
pnpm -r build
cd plugins/streamget-plugin && PYTHONPATH="$PWD/site-packages:$PWD" python3 -m unittest discover -s tests
# Ran 40 tests ... OK
```

## 7. 排错对照表

| 现象 | 多半是 | 动作 |
|---|---|---|
| 任务卡在 `needs_dep` | ffmpeg 找不到 | 看 `GET /api/health` 的 `binaries.ffmpeg`；跑 `pnpm fetch:ffmpeg` 或设 `TIDEWATCH_FFMPEG` |
| 一直 `reconnecting`，detail `stream_eof` | 证书或缺请求头 | 先手工验证：`./vendor/ffmpeg/bin/ffmpeg -v error -t 5 -i <url> -f null -`；`certificate verify failed` → 设 `SSL_CERT_FILE=/etc/ssl/cert.pem` |
| 页面能开但接口 401 | token 来自另一个数据根 | `cat <你启动时用的 data-root>/auth-token.txt` |
| 页面能开但一直"正在重连" | 反代掐了 WS / 浏览器拦了 cookie | 直连 8686 再试；chrome devtools 看 `/api/ws` 是否 101 |
| `curl` 写操作 403 `csrf` | 少了 CSRF 头 | 加 `-H 'X-TideWatch-Client: 1'` |
| 启动直接退出，日志"引擎租约被占用" | 同一个 data-root 起了两个 daemon | `pgrep -fl 'cli.js serve'`，先停一个（退出码 2 就是这个） |
| 端口占用 EADDRINUSE | 上一个没退干净 | `lsof -i :8686` 后 kill，或换 `--port` |
| 停止录制没反应 | body 字段写错 | 必须是 `{"recording":false}`；`{"on":false}` 会被当成默认 true |
| 删任务后历史记录也没了 | 既有 schema 行为：删任务级联删会话索引 | **磁盘视频不删**；要留历史就只关监控、别删任务 |

排障要证据时直接导出诊断包（设置页按钮，或 `POST /api/diagnostics/export`），
内容含版本、二进制来源、租约、最近事件与统计，不含 cookie 明文。

## 8. 收尾

```bash
# 优雅停止（等价 Ctrl-C / SIGTERM）：等录制收尾 → 超时硬杀 → 恢复扫描兜底
curl -sS --noproxy '*' -b /tmp/tw.jar -X POST $BASE/api/shutdown -H 'X-TideWatch-Client: 1'
# 或
node tools/smoke.mjs --port 8686 --data ./data --shutdown
```

数据根结构：

```
data/
  auth-token.txt          # 0600
  tidewatch.db            # node:sqlite，WAL
  downloads/<主播>/<日期_时间>_<new|cap>_<id>/
      part001.ts ...      # 源分段（默认保留）
      session.manifest.json
      <主播>_<日期>_<时间>.mp4
  exports/                # 诊断包
```

清场：停 daemon 后直接删 `data/` 即可（`*.db`、token 都会重建）；`vendor/` 与插件
`site-packages/` 都能用 `pnpm fetch:ffmpeg` / `requirements.lock` 重装。
