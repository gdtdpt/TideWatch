# 03 — 产物获取（下载 / 直链 / WebDAV）

> 状态：**设计稿，未实施**。2026-11-15 起草。
> 起因：服务在局域网随时可看，但「怎么看」只解决了播放，没解决「把文件拿到本地」。

## 1. 现状

| 能力 | 现状 | 位置 |
|---|---|---|
| 浏览器内播放 | ✅ `<video>` 直接吃 `GET /api/videos?path=` | `SessionDetail.tsx:219`、`MergeDetail.tsx:167` |
| Range 请求（拖动进度条） | ✅ `206 Partial Content` + `accept-ranges: bytes` | `routes/system.ts:142-159` |
| 目录穿越防护 | ✅ 解析后必须落在 `outputRoot` 内 | `routes/system.ts:132-137` |
| 命名下载（存盘文件名正确） | ❌ **无 `content-disposition`**，浏览器存成 `videos` | — |
| 批量取文件 | ❌ 只能一个个在网页里点 | — |
| 播放器直连（VLC/Infuse/nPlayer） | ❌ 需要手抄 URL 并自己带 cookie | — |

根因单一：`/api/videos` 当初只为「网页内播放」设计，`content-type` 还硬编码成 `video/mp4`
（`system.ts:156`、`system.ts:165`），对 `.ts` 分片和 `.m4a` 音轨都是错的。

## 2. 三个方案

### A. 命名下载（半小时，无新增安全面）

给 `/api/videos` 加两件事：

1. **`content-disposition`**：`attachment` 由查询参数触发，文件名按 RFC 6266 双写：
   ```
   content-disposition: attachment; filename="fallback.mp4"; filename*=UTF-8''%E6%9F%90%E4%B8%BB%E6%92%AD-20261115.mp4
   ```
   `filename=` 只留 ASCII 兜底，中文全靠 `filename*`。
2. **`content-type` 按扩展名**：`.mp4` → `video/mp4`、`.ts` → `video/mp2t`、`.m4a`/`.aac` → `audio/mp4`、
   `.mkv` → `video/x-matroska`；未知回落 `application/octet-stream`。

UI 侧在产物行加一个「下载」按钮，链到 `?path=…&download=1`——用普通 `<a download>` 即可，
不经过 fetch，浏览器原生断点续传、进度条、多文件并行都不用自己写。

**Range 与 `content-disposition` 可共存**，所以大文件下载仍能续传，不需要额外逻辑。

### B. 签名直链（给播放器和外部工具用）

`GET /api/videos?path=…&exp=<unix>&sig=<hmac>`，HMAC-SHA256 以 `auth-token.txt` 里的 token 为密钥，
覆盖 `path + exp`。校验通过则跳过 cookie 会话（但其它检查照旧：仍必须落在 `outputRoot` 内）。

- 有效期 10 分钟，够 VLC/Infuse 拉流；过期后播放器重连会 403，属预期。
- 签名 URL 由 UI 或 `POST /api/videos/sign` 生成，**不落库、不写日志**。
- 只用于 `GET`/`HEAD`，`POST`/`DELETE` 永不走签名分支。

价值：把「服务能播」变成「任何播放器都能播」，且不用把 token 交给第三方 App。

### C. WebDAV 只读挂载（135–200 行，默认关闭）

在现有 Fastify 上挂一个 `/dav/` 前缀，把 `outputRoot` 直接暴露成只读网盘：

| 方法 | 行为 |
|---|---|
| `OPTIONS` | `DAV: 1`、`Allow: OPTIONS, GET, HEAD, PROPFIND` |
| `PROPFIND` | `Depth: 0` / `1`，返回 `207 Multi-Status`；目录带 `<d:collection/>`，文件带 `getcontentlength` / `getlastmodified` / `getcontenttype` |
| `GET` / `HEAD` | 复用 A 的 Range 逻辑 |
| 其它 | `405`，**不实现 `PUT` / `DELETE` / `MKCOL` / `MOVE` / `LOCK`** |

#### 关键实现约束（容易踩的坑）

1. **鉴权要自己写**。现有 hook 第一行就是 `if (!req.url.startsWith('/api/')) return;`
   （`auth.ts:68`），`/dav/` 完全不在它的保护范围内。必须单独的 Basic auth：
   `WWW-Authenticate: Basic realm="TideWatch", charset="UTF-8"`，
   用户名任意（或固定 `tidewatch`），密码 = token，比对复用现成的 `safeEqual()`。
2. **`href` 要 percent-encode**。主播名和场次名几乎一定是中文，不编码 Finder 会挂载成乱码。
   XML 里还要做实体转义（`&` `<` `>`）。
3. **必须给 `Last-Modified` 和 `Content-Length`**，否则资源管理器会显示「0 字节」或干脆不列文件。
4. **Windows 资源管理器默认拒绝 http 的 Basic auth**，需改注册表
   `HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Services\WebClient\Parameters\BasicAuthLevel = 2`
   并重启 `WebClient` 服务。这是 Windows 侧策略，不是服务的问题——文档必须写明，否则会被当成 bug 排查。
5. **Finder 会尝试写 `.DS_Store`**。只读挂载下它写失败但**不影响浏览**；若要彻底安静，
   `PROPFIND` 结果里过滤掉以 `.` 开头的条目即可。
6. **`Depth: infinity` 直接 403**。部分客户端会试探它，对几百 GB 的目录递归遍历是灾难。

#### 安全代价（必须接受才做）

Basic auth 在 HTTP 上是**明文**。现有 UI 用 httpOnly cookie，没有这个问题。
所以 C 方案必须：

- `AppSettings.webdavEnabled` 默认 `false`，设置页显式开启才注册路由；
- 开启时在 UI 上给一条醒目提示：「同网段可嗅探到密码，跨网络请走 HTTPS 反代」；
- 不做多用户、不做可写。

## 3. 对比

| | A 命名下载 | B 签名直链 | C WebDAV |
|---|---|---|---|
| 实现量 | ~30 行 | ~60 行 | 135–200 行 + 设置项 + 文档 |
| 手机点一下就存 | ✅ | ✅ | ✅（挂载后） |
| 电脑批量拿几十个 | ❌ 一个个点 | ❌ | ✅ 拖文件夹 |
| 播放器直连 | ❌ | ✅ | ✅ |
| 新增攻击面 | **无** | 中（签名窗口 10 min） | **中高（明文密码）** |
| 改动文件 | `system.ts` + 2 个 tsx | `system.ts` + `auth.ts` | 新 `routes/dav.ts` + `auth.ts` + 设置页 |

## 4. 建议实施顺序

1. **A**——不引入任何安全面，且顺手修掉 `.ts` 分片的 `content-type` 错误。做完就能解决 80% 的诉求。
2. **B**——只有在「手机装 Infuse / 想让 VLC 播」这个场景真的出现时才做。
3. **C**——只在「要一批批把老录像搬走」时才做。默认关闭是硬要求。

A 和 B 可以一次提交；C 单独一个提交，因为它带设置项和文档改动。

## 5. 验收清单

**A**

- [ ] 页面点「下载」，存盘文件名是 `<主播>-<时间>.mp4`，不是 `videos`
- [ ] 中文主播名不乱码（Chrome、Safari、手机浏览器各验一次）
- [ ] 下载一个 >1 GB 的文件，中途暂停再继续，能续上（看 `206`）
- [ ] `.ts` 分片下载后 VLC 能播（验证 `content-type` 正确）
- [ ] 目录外路径仍然 `403`，不因新增参数被绕过

**B**

- [ ] 生成的签名 URL 粘到 VLC「打开网络串流」，能播、能拖进度
- [ ] 把 `exp` 改大一小时，`403`
- [ ] 把 `path` 改成 `/etc/passwd`，`403`（签名与路径都校验）
- [ ] 签名 URL 不出现在 `daemon.log` 里

**C**

- [ ] macOS Finder「连接服务器」`http://<ip>:8686/dav/`，能看到 `<主播>/<场次>/*.mp4`，中文正常
- [ ] iOS「文件」App 连接 WebDAV，能浏览并下载单个文件
- [ ] Android（Solid Explorer）同上
- [ ] Windows 资源管理器（改完注册表后）能挂载并复制整个文件夹
- [ ] `PUT` / `DELETE` / `MKCOL` 一律 `405`，文件没被改动
- [ ] 关闭设置项后 `/dav/` 直接 `404`
- [ ] 密码错 → `401` 且带 `WWW-Authenticate`

## 6. 明确不做

- 可写挂载（`PUT`/`DELETE`）——录制目录被误删无法恢复，收益远小于风险。
- 多用户 / 按目录授权。
- LOCK / UNLOCK（`DAV: 2`）——只读场景不需要，实现成本高。
- 在 WebDAV 里做在线转码或 HLS 切片。
