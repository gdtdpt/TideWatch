"""平台表 —— **新增一个平台 = 加一行**（M3.2 起表驱动）。

为什么把这张表单独拎出来：`adapters.py` 回答"怎么解析"，本模块回答"有哪些平台、
各自什么脾气"。两件事分开之后，接一个新平台从"读懂 adapters 再动六七处"变成"加一行"，
而"这一行有没有被验过"也一眼可见。

## 现在的范围（2026-10-07 用户定案）
**只接抖音与 B站**。其余平台一律先不接 —— 走插件模式，等正常使用后按需求后补。
后补一个平台要改 **3 处**（这是刻意的，越少越好）：

1. 本文件 `PLATFORM_ROWS` 加一行（`manifest_patterns` 与 `url` 两个字段都填）；
2. `plugin.json` 的 `url_patterns` / `platforms` 与表**派生出的完全一致**
   （`MANIFEST_PATTERNS` / `PLATFORM_NAMES`，`tests/test_platforms.py::ManifestSync` 会强制）；
3. `tests/test_adapters.py` 里那条 probe 样本（本行的 `sample_url` 就是给它用的）。

⚠️ `url` 是**正则**（插件自己识别用），`manifest_patterns` 是**纯子串**（宿主预过滤用，
`registry::matches_patterns` 只做 `lower.contains`）—— 两者语义不同，别混。

⚠️ **没实测过就别往表里加**：表里每一行都该在 `note` 里写清"什么时候、怎么验的"。
一个"选了就录不出/录出来是废文件"的平台比"不支持"更糟 ——
`adapters._BILI_CODEC_DENY` 里 av1 的教训就是这么来的（rc=0 但视频轨没了）。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

#: B站：2026-10-07 实测，CDN 校验**来源页 + UA 两者都要** ——
#: `Referer` 与 `User-Agent` 缺任一都直接
#: `Server returned 403 Forbidden (access denied)`；两个都给才 rc=0。
#: （早期只记了 Referer，实测证明单独给 Referer 仍然 403。）
#: UA 不必是完整浏览器串，`Mozilla/5.0` 就够 —— 但不能是 ffmpeg 默认的 `Lavf/...`。
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


@dataclass(frozen=True)
class Platform:
    """一个平台的"脾气"。字段全部可选填，默认值 = 最常见的那种情况。"""

    key: str
    """平台标识。写进 `tasks.platform_key` / cookie 存储键 / 事件与日志；只用 `[a-z0-9._-]`。"""

    name: str
    """中文显示名（UI 与事件文案里给用户看）。"""

    cls: str
    """streamget 里对应的类名（`getattr(streamget, cls)`）。"""

    fetch: str
    """取流数据的调用方式：`web` / `app` / 平台特例（见 `adapters._FETCHERS`）。"""

    url: str
    """URL 正则。插件自己识别平台用它（`adapters._match_platform`）。"""

    manifest_patterns: tuple[str, ...] = ()
    """写进 `plugin.json` 的 `url_patterns` —— 宿主预过滤用的是**纯子串**匹配
    （`registry::matches_patterns` 只做 `lower.contains`），不是正则。
    写太宽（比如只写 `douyin.com`）会把无关 URL 也吸进来，写太窄则该命中的不命中。"""

    sample_url: str = ""
    """probe 的离线样本地址（不联网，只验"这条 URL 认不认得出平台"）。"""

    flv_preferred: bool = False
    """FLV 优先平台：有 flv 就用 flv（单文件流最适合 ffmpeg 录制 + 断线重连）。"""

    overseas: bool = False
    """境外平台：核心据此选代理/并发策略。"""

    headers: dict[str, str] = field(default_factory=dict)
    """播放流**必须带的请求头**，由核心原样注入 `ffmpeg -headers`。

    为什么放在插件侧：这是**平台知识**。核心一旦硬编码就成了"核心认识每个平台"，
    与 docs/06 的架构约束冲突（核心只透传）。
    """

    note: str = ""
    """实测证据 / 已知坑。**新加平台必须填**，否则下次没人知道它到底验没验过。"""


PLATFORM_ROWS: tuple[Platform, ...] = (
    Platform(
        key="douyin",
        name="抖音",
        cls="DouyinLiveStream",
        fetch="douyin",
        url=r"https?://(live\.douyin\.com|v\.douyin\.com|www\.douyin\.com/user)/",
        manifest_patterns=("live.douyin.com", "v.douyin.com", "www.douyin.com/user"),
        sample_url="https://live.douyin.com/745964462470",
        flv_preferred=True,
        note=(
            "2026-10-06 开播分支实测通过（沙箱内直跑 streamget + 捆绑 ffprobe 探流）。"
            "主页地址（v.douyin.com/xxx、www.douyin.com/user/xxx）走 app 取数，见 adapters._fetch_douyin。"
            "取流签名由 ab_sign（douyin/ab_sign.py，纯 Python）完成，**不依赖 Node**；"
            "清单里的 optional node 是给上游其他签名类平台留的，与本平台无关。"
        ),
    ),
    Platform(
        key="bilibili",
        name="B站",
        cls="BilibiliLiveStream",
        fetch="web",
        url=r"https?://live\.bilibili\.com/",
        manifest_patterns=("live.bilibili.com",),
        sample_url="https://live.bilibili.com/6",
        headers={"Referer": "https://live.bilibili.com/", "User-Agent": BROWSER_UA},
        note=(
            "2026-10-07 房间 6 三档联机复测：选原画→qn=10000(hevc)、选超清→qn=250(avc)、"
            "选房间没有的蓝光→降 250 并打 warn。"
            "两条专属知识都落在 adapters：① 取流优先新接口 getRoomPlayInfo（老接口未登录会**静默降级**）；"
            "② 剔除 av1 线路（ffmpeg copy 出来的 TS 视频轨退化成 bin_data，rc 仍为 0）。"
            "**录制不需要登录**（未登录即可拿原画 1080p）；只有 4K/杜比（qn 20000/30000）才需要。"
        ),
    ),
)


#: key → 行。查表用这个，不要在别处再抄一份。
PLATFORMS: dict[str, Platform] = {p.key: p for p in PLATFORM_ROWS}

#: 供 `plugin.json` 生成 / 校验用（顺序即表序）。
URL_PATTERNS: list[tuple[str, re.Pattern]] = [
    (p.key, re.compile(p.url)) for p in PLATFORM_ROWS
]


# ---------- 点播（VOD）：单集下载，M6.1 ----------


@dataclass(frozen=True)
class VodPlatform:
    """一个平台的**点播**脾气（与直播那张表分开：识别规则、取数方式都不同）。

    为什么另起一张表而不是给 `Platform` 加字段：直播与点播的 `url` 正则**互斥**
    （`live.bilibili.com/6` vs `www.bilibili.com/video/BV...`），混在一行里会让
    "这个平台支持直播但不支持点播"没法表达 —— 而那是常态（抖音就不在点播表里）。

    加一个点播平台同样只改 3 处：本表加一行 / `plugin.json` 的 `url_patterns`
    （由 `MANIFEST_PATTERNS` 派生，测试强制）/ `tests/test_adapters.py` 的样本。
    """

    key: str
    """与直播表同一个 key（同一平台的两种内容形态）。"""

    name: str
    url: str
    """点播 URL 正则（`adapters._match_vod_platform` 用）。"""

    manifest_patterns: tuple[str, ...] = ()
    sample_url: str = ""
    note: str = ""


VOD_ROWS: tuple[VodPlatform, ...] = (
    VodPlatform(
        key="bilibili",
        name="B站",
        # `m.bilibili.com` 是移动版同一套 BV 号；`b23.tv` 是官方短链（会 302 到正片）
        url=r"https?://(www\.bilibili\.com/video/|m\.bilibili\.com/video/|b23\.tv/)",
        manifest_patterns=("bilibili.com/video", "b23.tv"),
        sample_url="https://www.bilibili.com/video/BV1GJ411x7h7",
        note=(
            "2026-10-17 未登录实测：`x/web-interface/view` 给 cid/pages/duration；"
            "`x/player/playurl?fnval=16` 给 4 条 video 轨（hev1/avc1）+ 3 条 audio 轨；"
            "直链 HEAD 200 且带 backupUrl。⚠️ **未登录只给 480P**（accept_description 仍列 1080P+，"
            "别拿它当实际可得档位）—— UI 必须说清「这是平台限制，不是我们压的」。"
            "裸 `BV1...` / `av123` 由 adapters.normalize_vod_url 补全成完整 URL 后再进这里。"
        ),
    ),
)

#: 点播 key → 行。
VOD_PLATFORMS: dict[str, VodPlatform] = {p.key: p for p in VOD_ROWS}
VOD_URL_PATTERNS: list[tuple[str, re.Pattern]] = [
    (p.key, re.compile(p.url)) for p in VOD_ROWS
]

#: `plugin.json` 的 `url_patterns` **应当**逐字等于这个列表（有测试强制）。
#:
#: 直播与点播两套子串合在一起：宿主预过滤只做 `lower.contains`，它不需要知道
#: "这条是直播还是点播"（那是 `probe` 的回答）。
MANIFEST_PATTERNS: list[str] = [
    pat for p in PLATFORM_ROWS for pat in p.manifest_patterns
] + [pat for p in VOD_ROWS for pat in p.manifest_patterns]
PLATFORM_NAMES: dict[str, str] = {p.key: p.name for p in PLATFORM_ROWS}
HTTP_HEADERS: dict[str, dict[str, str]] = {
    p.key: dict(p.headers) for p in PLATFORM_ROWS if p.headers
}
OVERSEAS: set[str] = {p.key for p in PLATFORM_ROWS if p.overseas}
SAMPLE_URLS: dict[str, str] = {
    p.key: p.sample_url for p in PLATFORM_ROWS if p.sample_url
}
VOD_SAMPLE_URLS: dict[str, str] = {
    p.key: p.sample_url for p in VOD_ROWS if p.sample_url
}
