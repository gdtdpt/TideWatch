"""adapters：URL 平台识别、streamget 调用、协议字段映射、异常→错误码翻译。

streamget 调用方式与 StreamCap handlers.py 一致（薄封装）：
  XxxLiveStream(proxy_addr, cookies) -> fetch_{web,app}_stream_data(url) -> fetch_stream_url(json, quality)

**平台清单不在这里** —— 见 `platforms.py`（表驱动，新增平台 = 加一行）。
本模块只放"怎么解析"，以及平台**专属**的取流/画质知识（目前只有 B站 一处）。
stdout 只允许协议 JSON，任何库的打印都被重定向到 stderr（见 main.py）。
"""
import asyncio
import json
import re
import sys
import urllib.parse
from typing import Any, Callable

import streamget
from streamget.requests.async_http import async_req

from platforms import (
    BROWSER_UA, HTTP_HEADERS, OVERSEAS, PLATFORMS, PLATFORM_NAMES, URL_PATTERNS,
    VOD_PLATFORMS, VOD_URL_PATTERNS,
)

PROTOCOL_VERSION = 2

#: B站画质码 → qn。**与 streamget 内置映射逐字一致**（含数字索引写法 `0`→OD、`1`→BD…），
#: 避免同一份配置在两个实现里解释成不同档位。
BILI_QUALITY_QN = {"OD": 10000, "BD": 400, "UHD": 250, "HD": 150, "SD": 80, "LD": 80}
BILI_QN_NAMES = {30000: "杜比", 20000: "4K", 10000: "原画", 400: "蓝光",
                 250: "超清", 150: "高清", 80: "流畅"}
#: 标签 → qn 的反向表，由 `BILI_QN_NAMES` 派生（唯一真源，别再手抄一份）。
_LABEL_QN: dict[str, int] = {v: k for k, v in BILI_QN_NAMES.items()}

#: streamget **自己**的画质词表（`fetch_stream_url` 的 `video_quality_options`，
#: 见 site-packages/streamget/platforms/bilibili/live_stream.py）。它只认这六个值，
#: 而且把数字当"下标"用 —— 喂进去之前一律先过 `_streamget_quality`。
_STREAMGET_QN: list[tuple[str, int]] = [
    ("OD", 10000), ("BD", 400), ("UHD", 250), ("HD", 150), ("SD", 80),
]

#: 同画质档位内的偏好序（越小越优先）。画质档位是**第一优先级**，这两个只在同 qn 内比。
#:   format：`flv` 单文件流最适合 ffmpeg 录制 + 断线重连；`ts`/`fmp4` 是 HLS 分片清单。
#:   codec：`avc` 兼容性最好（老播放器 / 剪辑软件通吃），hevc / av1 次之。
_BILI_FORMAT_PREF = {"flv": 0, "ts": 1, "fmp4": 2}
_BILI_CODEC_PREF = {"avc": 0, "hevc": 1, "av1": 2}

#: **不接受的编码**，直接从候选里剔除。`av1` 是实测结论（2026-10-07，ffmpeg 8.1.3）：
#: 拉 AV1 线路时 ffmpeg 报 `Failed to parse temporal unit`，**copy 录出的 TS 里视频轨
#: 变成 `bin_data`、只有音频** —— 文件等于废了，而 rc 仍是 0（静默失败）。
#: 对比同房间 flv/fmp4/ts 的 avc/hevc 全部正常 → 是 AV1 的问题，不是封装的问题。
#: 宁可在同房间降一档拿到可用的 avc/hevc，也不要一个"看起来录上了"的空壳。
_BILI_CODEC_DENY = {"av1"}


class PluginError(Exception):
    """携带协议错误响应的业务异常（docs/04 §3.3）。"""

    def __init__(self, code: str, message: str, retryable: bool = False, retry_after_s: int | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable
        self.retry_after_s = retry_after_s

    def response(self, req_id: Any) -> dict:
        return error_response(req_id, self.code, self.message, self.retryable, self.retry_after_s)


def error_response(req_id: Any, code: str, message: str, retryable: bool, retry_after_s: int | None = None) -> dict:
    error: dict[str, Any] = {"code": code, "message": message, "retryable": retryable}
    if retry_after_s is not None:
        error["retry_after_s"] = retry_after_s
    return {"id": req_id, "ok": False, "error": error}


def classify_exception(e: Exception) -> tuple[str, str, bool, int | None]:
    """异常 → (code, message, retryable, retry_after_s)。"""
    import execjs

    if isinstance(e, execjs.RuntimeUnavailableError):
        return ("DEPENDENCY_MISSING", "Node.js 未找到（PATH 中无 node）", False, None)
    if isinstance(e, execjs.ProgramError):
        if "Node.js" in str(e) or "node" in str(e).lower():
            return ("DEPENDENCY_MISSING", f"Node.js 执行签名失败: {e}", False, None)
        return ("PLATFORM_CHANGED", f"签名 JS 执行失败: {e}", False, None)
    if isinstance(e, FileNotFoundError):
        return ("DEPENDENCY_MISSING", f"外部依赖缺失: {e}", False, None)

    import httpx

    if isinstance(e, (httpx.HTTPError, asyncio.TimeoutError, TimeoutError, ConnectionError)):
        return ("NETWORK", f"网络错误: {type(e).__name__}: {e}", True, None)

    msg = str(e)
    # ⚠️ 顺序有意义：风控是**平台明确说了**（响应体/异常里带 risk control / 风控），
    # 而"空响应 / 解析不出 JSON"是另一回事 —— 它更可能是网络被中断或页面结构变了。
    # 把后者也标成"风控"，用户会白等 60s 退避，还会误以为账号被封（M3.2 修正）。
    if "risk control" in msg or "风控" in msg:
        return ("RATE_LIMITED", f"平台风控: {msg}", True, 60)
    # 平台明确说"你没权限看"：主播设了观看范围（抖音 2026-11-03 真机：连着 46 次
    # 每 30 秒撞一次门）、付费直播、仅粉丝团可见。这既不是网络问题也不是我们的 bug，
    # 属于"除非用户去登录/加团，否则这一场看不到" —— 给长退避，别持续撞。
    if any(k in msg for k in ("可见范围", "观看权限", "无权观看", "仅粉丝团", "付费直播", "专属直播")):
        return ("RESTRICTED", f"平台拒绝进房: {msg}", True, 1800)
    # 主播没开播 / 刚下播。抖音的 webcast 在下播时**抛异常**而不是返回空数据，
    # 兜底成 INTERNAL 的后果是：下播期间每 30 秒记一条"出错"，一天刷上千条
    # （2026-11-04 实测 61 条）。"没开播"是正常状态，不是错误。
    if any(k in msg for k in ("直播已结束", "已下播", "未开播", "主播不在", "not live", "room not live")):
        return ("NOT_LIVE", msg, True, None)
    if "VR live" in msg:
        # ⚠️ 这句话是 streamget 的**兜底文案**，不能照抄成结论：`_get_web_stream_data`
        # 只在 `data` 为空且没有 `prompts` 时抛它，而**房间下播**同样会让 `data` 变空
        # （2026-10-25 真机：一场录了 60s 的直播断流后，解析连着半小时都报这句，
        # 房间其实只是结束了）。断言"这是 VR 房间"是**我们不知道的事**，
        # 如实描述拿到的事实（没有直播数据），把判断留给用户。
        return ("UNSUPPORTED_URL", "平台未返回直播数据（可能已下播，或该房间类型不受支持）", False, None)
    if "Fetch stream data error" in msg or "Fetch failed" in msg:
        return ("PLATFORM_CHANGED", f"平台页面结构变更或地址无效: {msg}", False, None)
    if not msg.strip() or "Expecting value" in msg or "JSONDecodeError" in msg:
        # 空 / 畸形响应：**没有风控证据就不判风控**，按可重试的网络问题处理
        return ("NETWORK", f"平台返回空或畸形响应: {msg or '(empty)'}", True, None)
    return ("INTERNAL", f"{type(e).__name__}: {e}", True, None)


def _match_platform(url: str) -> str | None:
    for platform, pattern in URL_PATTERNS:
        if pattern.search(url):
            return platform
    return None


def _match_vod_platform(url: str) -> str | None:
    """点播平台识别。**先于点播识别做 normalize**（裸 BV / av 号也能认）。"""
    for platform, pattern in VOD_URL_PATTERNS:
        if pattern.search(normalize_vod_url(url)):
            return platform
    return None


def probe(req: dict) -> dict:
    url = req.get("url", "")
    # 点播先判：`bilibili.com/video/...` 与直播的 `live.bilibili.com` 互斥，
    # 但顺序仍固定为"先点播"——否则将来某个平台的点播域名含着直播域名时
    # （如 `www.x.com/live/video/1`）会被误判成直播。
    vod = _match_vod_platform(url)
    if vod is not None:
        return {
            "id": req.get("id"),
            "ok": True,
            "platform": vod,
            "platform_name": VOD_PLATFORMS[vod].name,
            "kind": "vod",
        }
    platform = _match_platform(url)
    if platform is None:
        return {"id": req.get("id"), "ok": True, "platform": None}
    return {
        "id": req.get("id"),
        "ok": True,
        "platform": platform,
        "platform_name": PLATFORM_NAMES.get(platform, platform),
        "kind": "live",
    }


def _fetch_douyin(ls: Any, url: str) -> Any:
    """抖音主页地址走 app 取数（网页端 `live.douyin.com/xxx` 走 web）。"""
    if "v.douyin.com" in url or "www.douyin.com/user" in url:
        return ls.fetch_app_stream_data(url=url)
    return ls.fetch_web_stream_data(url=url)


#: `Platform.fetch` → 实际调用。加平台时若需要新的取数方式，在这里补一个即可。
_FETCHERS: dict[str, Callable[[Any, str], Any]] = {
    "web": lambda ls, url: ls.fetch_web_stream_data(url=url),
    "app": lambda ls, url: ls.fetch_app_stream_data(url=url),
    "douyin": _fetch_douyin,
}


def _bili_target_qn(quality: Any) -> int:
    """用户要的画质 → qn 码。四种写法都认：

    - streamget 词表：`"OD"` / `"BD"` / `"UHD"` / `"HD"` / `"SD"` / `"LD"`；
    - **数字下标**：`"0"`→OD、`"1"`→BD…（streamget 的老写法，逐字兼容，别删）；
    - **中文标签**：`"原画"` / `"超清"` / `"4K"`…（UI 下拉里给用户看的就是它，
      见 `_bili_quality_options`）；
    - **裸 qn 码**：`"10000"` / `"400"`（数字 ≥ 词表长度时才当码用，`"0".."5"` 仍是下标）。

    认不出来一律回 `10000`（原画）：宁可高不可低，画质低了是不可逆的损失。
    """
    keys = list(BILI_QUALITY_QN)
    text = str(quality if quality not in (None, "") else "OD").strip()
    if text in _LABEL_QN:
        return _LABEL_QN[text]
    if text.isdigit():
        n = int(text)
        return BILI_QUALITY_QN[keys[n]] if n < len(keys) else n
    return BILI_QUALITY_QN.get(text.upper(), 10000)


def _streamget_quality(quality: Any) -> str:
    """任意画质表达 → streamget 词表里**安全**的值。

    ⚠️ 必须过这一层：streamget 的 `fetch_stream_url` 把**数字当"下标"**用
    （`list(keys)[int(v)]`），直接把 `"400"`（qn 码）喂进去就是 `IndexError` →
    整次解析变成可重试的 `INTERNAL`，用户只会看到"这个任务一直解析失败"。
    """
    qn = _bili_target_qn(quality)
    for code, level in _STREAMGET_QN:
        if qn >= level:
            return code
    return "SD"


def _bili_quality_options(playurl: dict | None) -> list[str]:
    """房间**实际可选**的画质标签（高 → 低），供 UI 下拉。

    只统计"真能录"的线路：`_BILI_CODEC_DENY` 里的编码整条剔除（av1 录出来没有视频轨）、
    没有 `url_info` 的也不算 —— 下拉里给出一个选不了或录不出的档位，比不给更糟。
    返回的是**中文标签**（`BILI_QN_NAMES`），它经 `_bili_target_qn` 可以原样回环。
    """
    qns: set[int] = set()
    for stream in (playurl or {}).get("stream") or []:
        for fmt in stream.get("format") or []:
            for codec in fmt.get("codec") or []:
                if codec.get("codec_name") in _BILI_CODEC_DENY or not codec.get("url_info"):
                    continue
                qn = int(codec.get("current_qn") or 0)
                if qn > 0:
                    qns.add(qn)
    return [BILI_QN_NAMES.get(qn, str(qn)) for qn in sorted(qns, reverse=True)]


async def _bilibili_pick_stream(ls: Any, url: str, quality: Any) -> dict | None:
    """B站专用取流：走**新接口** `getRoomPlayInfo`，返回选出的一条线路 + 实际可用档位，或 None。

    为什么不用 streamget 内置的 `get_bilibili_stream_data`：它**先试老接口**
    `room/v1/Room/playUrl`，只要 `code == 0` 就直接返回 —— 而**未登录时老接口会静默降级**。
    2026-10-07 实测：房间 6 请求 qn=10000（原画）只回 150（高清）→ 854×480；同一房间走
    新接口是 1920×1080。降级既不改 `code` 也不报错，用户只会觉得"B站录出来怎么这么糊"。

    选择规则：**先卡画质档位**（≤ 目标 qn 里取最大），再在同档位内偏好 `flv` 与 `avc`。
    画质优先于编码兼容 —— 房间 6 的原画只有 HEVC 线路，若坚持 AVC 就只能录到 250（超清）；
    而 HEVC 的 MP4 现代播放器都能放，低画质则是不可逆的损失。
    """
    target = _bili_target_qn(quality)
    room_id = url.split("?")[0].rsplit("/", maxsplit=1)[1]
    params = {
        "room_id": room_id, "protocol": "0,1", "format": "0,1,2", "codec": "0,1,2",
        "qn": str(target), "platform": "web", "ptype": "8",
        "dolby": "5", "panorama": "1", "hdr_type": "0,1",
    }
    api = ("https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?"
           + urllib.parse.urlencode(params))
    data = json.loads(await async_req(api, proxy_addr=ls.proxy_addr, headers=ls.pc_headers))
    playurl = ((data.get("data") or {}).get("playurl_info") or {}).get("playurl")
    if data.get("code") != 0 or not playurl:
        return None

    best: tuple | None = None
    for stream in playurl.get("stream") or []:
        for fmt in stream.get("format") or []:
            for codec in fmt.get("codec") or []:
                if codec.get("codec_name") in _BILI_CODEC_DENY:
                    continue
                qn = int(codec.get("current_qn") or 0)
                if qn > target or not codec.get("url_info"):
                    continue
                key = (-qn,
                       _BILI_FORMAT_PREF.get(fmt.get("format_name"), 9),
                       _BILI_CODEC_PREF.get(codec.get("codec_name"), 9))
                if best is None or key < best[0]:
                    info = codec["url_info"][0]
                    best = (key, info["host"] + codec["base_url"] + info["extra"],
                            qn, codec.get("codec_name"), fmt.get("format_name"))
    if best is None:
        return None
    return {
        "url": best[1], "qn": best[2], "codec": best[3], "format": best[4],
        # 下拉要的是"这个房间到底有哪些档"，与"我这次选了哪条"是两件事：
        # 房间 6 实测 = 原画(仅 hevc) + 超清；没有 400/150 —— 给不出就别假装有。
        "options": _bili_quality_options(playurl),
    }


def _unsupported(platform: str | None, url: str) -> PluginError:
    """"这个平台我们没接" —— 必须与"解析失败"分开表达。

    2026-10-07 用户定案只接抖音与 B站，其余平台靠插件模式后补。此时用户粘一条虎牙地址，
    若只回一句笼统的解析错误，他分不清是地址写错、程序坏了、还是本来就不支持。
    `PLATFORM_UNSUPPORTED` 让宿主能给出"该平台暂未支持 + 怎么补"。
    """
    supported = "、".join(PLATFORM_NAMES.values())
    if platform is None:
        return PluginError(
            "PLATFORM_UNSUPPORTED",
            f"暂不支持该平台：没有插件能识别这个地址（{url}）。当前支持 {supported}；"
            "其它平台可放入对应插件后再试。",
        )
    return PluginError(
        "PLATFORM_UNSUPPORTED",
        f"暂不支持该平台（{platform}）。当前支持 {supported}；"
        "其它平台可放入对应插件后再试。",
    )


def _generic_quality_actual(sd: Any, requested: Any) -> dict | None:
    """非 B 站平台的"实际画质"。

    streamget 对其它平台只暴露一个 `quality` 字符串，既不保证语义也不保证有值 ——
    所以这里只做**如实转述**：`degraded` 一律 False（判断不了就别谎报），
    `requested` 只在用户显式设了档位时才填。
    """
    label = getattr(sd, "quality", None)
    if not label:
        return None
    return {
        "qn": None,
        "label": str(label),
        "codec": None,
        "format": None,
        "requested": None if requested in (None, "") else str(requested),
        "degraded": False,
    }


def _bili_quality_actual(bili: dict, requested: Any) -> dict:
    """B站"实际画质"：qn + 中文档位 + 编码 + 封装，并判定是否被降级。

    降级的比较基准是 `min(用户请求, 房间可选最高档)`：房间本身最高只有蓝光时，
    "请求原画却拿到蓝光"不该报警（上不去不是被降级）；只有连**本房间能给的最好**
    都没拿到，才是真正的静默降级（未登录 / 会员画质 / 线路问题）。
    """
    explicit = requested not in (None, "")
    want = _bili_target_qn(requested)
    best_option = max((_LABEL_QN.get(x, 0) for x in bili["options"]), default=0)
    ceiling = min(want, best_option) if best_option > 0 else want
    asked_qn = want if explicit else (best_option or want)
    return {
        "qn": bili["qn"],
        "label": BILI_QN_NAMES.get(bili["qn"], str(bili["qn"])),
        "codec": bili["codec"],
        "format": bili["format"],
        "requested": BILI_QN_NAMES.get(asked_qn, str(asked_qn)),
        "degraded": bili["qn"] < ceiling,
    }


def resolve(req: dict) -> dict:
    url = req.get("url", "")
    platform = req.get("platform") or _match_platform(url)
    spec = PLATFORMS.get(platform) if platform else None
    if spec is None:
        raise _unsupported(platform, url)

    ls = getattr(streamget, spec.cls)(proxy_addr=req.get("proxy"), cookies=req.get("cookies"))
    fetch: Callable[[], Any] = lambda: _FETCHERS[spec.fetch](ls, url)  # noqa: E731

    loop = asyncio.new_event_loop()
    bili = None
    try:
        json_data = loop.run_until_complete(fetch())
        sd = loop.run_until_complete(
            # ⚠️ 必须过 `_streamget_quality`：UI 下拉给的是中文标签 / qn 码，
            # 直接喂给 streamget 会被当成"下标"（`list(keys)["400"]` → 崩）。
            ls.fetch_stream_url(json_data, _streamget_quality(req.get("quality")))
        )
        # B站：上面这一步走的是 streamget 老接口，**未登录会静默降级**（见
        # `_bilibili_pick_stream` 的注释）。这里用新接口重取一次覆盖掉它。
        # 失败/取不到就**保留**老接口结果 —— 宁可画质低，也不能录不了。
        if platform == "bilibili" and sd.is_live:
            try:
                bili = loop.run_until_complete(
                    _bilibili_pick_stream(ls, url, req.get("quality"))
                )
            except Exception as e:  # 增强路径，任何失败都不该连带本次解析一起失败
                print(f"[bilibili] 新接口取流失败，回退老接口结果: {e}", file=sys.stderr)
    finally:
        loop.close()

    if not sd.is_live:
        return {
            "id": req.get("id"), "ok": True, "platform": platform,
            "anchor_name": sd.anchor_name, "title": None, "is_live": False,
            "quality_options": [], "extra": {},
        }

    if bili is not None:
        record_url = bili["url"]
        want = _bili_target_qn(req.get("quality"))
        quality_actual = _bili_quality_actual(bili, req.get("quality"))
        level = "warn" if quality_actual["degraded"] else "info"
        print(f"[bilibili] {level}: 实际 qn={bili['qn']}({BILI_QN_NAMES.get(bili['qn'], '?')}) "
              f"codec={bili['codec']} fmt={bili['format']}（请求 {want}；"
              f"本房间可选 {bili['options']}）", file=sys.stderr)
        quality_options = bili["options"]
    elif spec.flv_preferred and sd.flv_url:
        # FLV 优先平台：flv 可用则用 flv（h265→HLS 的退避判断在 M3 补齐，见验证记录）
        record_url = sd.flv_url
        quality_options = [sd.quality] if sd.quality else []
        quality_actual = _generic_quality_actual(sd, req.get("quality"))
    else:
        # 部分平台只填 record_url，留作最终兜底
        record_url = sd.m3u8_url or sd.flv_url or sd.record_url
        quality_options = [sd.quality] if sd.quality else []
        quality_actual = _generic_quality_actual(sd, req.get("quality"))

    extra = dict(sd.extra or {})
    return {
        "id": req.get("id"), "ok": True, "platform": platform,
        "anchor_name": sd.anchor_name, "title": sd.title, "is_live": True,
        "record_url": record_url,
        "flv_url": sd.flv_url, "m3u8_url": sd.m3u8_url,
        "is_overseas": platform in OVERSEAS,
        # 协议 2：播放请求头（核心注入 `ffmpeg -headers`）；无头平台给空 dict。
        "http_headers": dict(HTTP_HEADERS.get(platform) or {}),
        # 协议 2（D3）：平台刷新后的 cookie 走**顶层字段**，不再塞进 extra 里
        # （藏在 extra 里宿主看不见，Cookie 管理就永远闭不了环）。
        "cookies_out": sd.new_cookies or None,
        # 画质下拉的选项 = 该房间**最近一次解析到的真实可用档位**（B站给全档，
        # 其余平台 streamget 只暴露单值 → 退化成一项，UI 会自动转回自由填写）。
        "quality_options": quality_options,
        # 这次**实际**选中的档位（协议 2 平铺）。平台静默降级时只有它能说明真相：
        # 请求原画、拿到高清，`code` 仍是 0 —— 没有这一项，用户只能靠肉眼判断。
        "quality_actual": quality_actual,
        "extra": extra,
    }


# ---------------------------------------------------------------------------
# 点播（VOD）单集下载 —— M6.1，docs/08 §3
#
# 两个 action 刻意拆开（协议见 plugin-host/src/vod.rs 的模块文档）：
#   fetch_vod_meta    → 元数据（标题/UP主/分集/画质档），可缓存、可落库
#   fetch_vod_streams → 直链（**不落库**：带签名 token，进库就是泄漏），每个 P 现取
#
# 拆开的真正原因不是"分层好看"：直链有**时效**（B站 DASH 实测约 2h），而多 P 全下
# 可能跑几小时 —— 开始下载时一次取全，后面的 P 一定是过期链接。
# ---------------------------------------------------------------------------

#: B站点播页要的请求头（与直播同一个 CDN 校验：Referer + UA 缺一即 403）
BILI_VOD_HEADERS = {
    "Referer": "https://www.bilibili.com/",
    "User-Agent": BROWSER_UA,
}

BILI_API_VIEW = "https://api.bilibili.com/x/web-interface/view"
BILI_API_PLAYURL = "https://api.bilibili.com/x/player/playurl"
BILI_API_NAV = "https://api.bilibili.com/x/web-interface/nav"

#: B站点播画质 qn → 中文标签。**只用于把用户输入映射成 qn**；真正的可选档位
#: 一律以平台回的 `accept_description` 为准（不同稿件差很多：4K/60帧/HDR 各不相同）。
BILI_VOD_QN_BY_LABEL: tuple[tuple[str, int], ...] = (
    ("8K", 127), ("杜比", 126), ("HDR", 125), ("4K", 120),
    ("1080P60", 116), ("1080P", 80), ("720P60", 74), ("720P", 64),
    ("480P", 32), ("360P", 16),
)

_BV_RE = re.compile(r"^BV[0-9A-Za-z]{10}$")
_AV_RE = re.compile(r"^av(\d+)$", re.IGNORECASE)


def normalize_vod_url(url: str) -> str:
    """裸 `BV1...` / `av123456` → 完整 URL。

    用户在输入框里粘的经常只是 BV 号（那是 B站分享里最显眼的标识）。
    在**插件侧**做而不是前端做：BV 号的形态是平台知识，前端不该认识它。
    """
    u = (url or "").strip()
    if _BV_RE.match(u):
        return f"https://www.bilibili.com/video/{u}"
    m = _AV_RE.match(u)
    if m:
        return f"https://www.bilibili.com/video/av{m.group(1)}"
    return u


def _bili_vod_ids(url: str) -> tuple[str, str] | None:
    """从 URL 里取 `(参数名, 值)`：`("bvid", "BV...")` 或 `("aid", "123")`。"""
    path = urllib.parse.urlparse(url).path
    for seg in path.split("/"):
        if _BV_RE.match(seg):
            return ("bvid", seg)
        m = _AV_RE.match(seg)
        if m:
            return ("aid", m.group(1))
    return None


def _page_param(url: str) -> int | None:
    """`?p=3` → 3（显式指定单 P 时优先于"全部 P"，见 docs/08 §3.1）。"""
    q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
    raw = (q.get("p") or [""])[0]
    return int(raw) if raw.isdigit() and int(raw) > 0 else None


def _bili_vod_qn(quality: Any) -> int:
    """画质输入 → qn 码。认 `auto` / 数字 / 中文标签 / `1080P 高清` 这类平台原文。"""
    text = str(quality if quality not in (None, "") else "auto").strip()
    if text.isdigit():
        return int(text)
    upper = text.upper()
    if upper in ("AUTO", "MAX", "最高"):
        return 127
    for label, qn in BILI_VOD_QN_BY_LABEL:  # 长标签在前，"1080P60" 先于 "1080P"
        if label.upper() in upper:
            return qn
    # 认不出来 → 要最高：画质低了是不可逆的损失（与直播 `_bili_target_qn` 同一取向）
    return 127


async def _fetch_short_url(url: str, proxy: str | None) -> str:
    """`b23.tv` 短链 → 真地址（302 跟随）。失败则原样返回，让后面的解析给出真错误。"""
    if "b23.tv" not in url:
        return url
    try:
        final = await async_req(
            url, proxy_addr=proxy, headers=BILI_VOD_HEADERS, redirect_url=True
        )
        return final if isinstance(final, str) and final.startswith("http") else url
    except Exception as e:  # 短链服务挂了不该变成"插件崩了"
        print(f"[bilibili-vod] 短链解析失败，按原地址继续: {e}", file=sys.stderr)
        return url


async def _bili_api(path: str, params: dict, cookies: str | None, proxy: str | None) -> dict:
    headers = dict(BILI_VOD_HEADERS)
    if cookies:
        headers["Cookie"] = cookies
    body = await async_req(
        f"{path}?{urllib.parse.urlencode(params)}",
        proxy_addr=proxy,
        headers=headers,
    )
    return json.loads(body)


def _vod_error(code: int, message: str) -> PluginError:
    """B站业务码 → 协议错误。

    `-404` / `62002`（稿件不可见）是**确定性**的：重试一百次也一样，所以
    `retryable=False`，并用 `UNSUPPORTED_URL` 而非 `NETWORK` —— 后者会让宿主
    按退避曲线一直重试，用户只看到"一直是网络错误"。
    """
    if code in (-404, 62002):
        return PluginError("UNSUPPORTED_URL", f"稿件不存在或已不可见：{message}")
    if code in (-403, -10403):
        return PluginError("UNSUPPORTED_URL", f"没有权限访问该稿件（可能需要登录/大会员）：{message}")
    if code == -412:
        return PluginError("RATE_LIMITED", f"平台风控：{message}", True, 60)
    return PluginError("INTERNAL", f"B站接口返回 code={code}：{message}", True)


def _pick_vod_video(
    videos: list[dict], target_qn: int
) -> tuple[dict | None, list[str], list[tuple[int, str]]]:
    """在 `dash.video` 里挑一条：**档位优先**，同档优先 avc（兼容性），剔除 av1。

    与直播 `_bilibili_pick_stream` 同一条取向后半句的理由：av1 在 ffmpeg copy 下
    不保证可用（直播那次是视频轨退化成 bin_data、rc 仍为 0）。点播能避开就避开。
    """
    options: list[tuple[int, str]] = []
    best: tuple[tuple, dict] | None = None
    for v in videos:
        ids = int(v.get("id") or 0)
        codecs = str(v.get("codecs") or "").lower()
        if codecs.startswith("av01"):
            continue
        if ids > target_qn:
            continue
        key = (-ids, 0 if codecs.startswith("avc") else 1)
        if best is None or key < best[0]:
            best = (key, v)
        if ids not in [o[0] for o in options]:
            options.append((ids, codecs))
    return (best[1] if best else None), [c for _, c in options], options


def _vod_urls(track: dict) -> list[str]:
    """直链候选：`base_url`/`baseUrl` 两种写法（新旧接口），再加 backup。"""
    urls: list[str] = []
    for key in ("base_url", "baseUrl"):
        if track.get(key):
            urls.append(track[key])
            break
    for key in ("backup_url", "backupUrl"):
        for u in track.get(key) or []:
            if u:
                urls.append(u)
    return urls


async def fetch_vod_meta(req: dict) -> dict:
    """元数据：标题 / UP 主 / 分集 / 该稿件实际可用画质。"""
    url = await _fetch_short_url(normalize_vod_url(req.get("url", "")), req.get("proxy"))
    platform = req.get("platform") or _match_vod_platform(url)
    if platform is None or platform not in VOD_PLATFORMS:
        raise PluginError(
            "PLATFORM_UNSUPPORTED",
            f"暂不支持该点播地址：{url}。当前点播支持 "
            + "、".join(p.name for p in VOD_PLATFORMS.values()),
        )
    ids = _bili_vod_ids(url)
    if ids is None:
        raise PluginError("UNSUPPORTED_URL", f"地址里找不到 BV 号或 av 号：{url}")

    cookies = req.get("cookies")
    proxy = req.get("proxy")
    view = await _bili_api(BILI_API_VIEW, {ids[0]: ids[1]}, cookies, proxy)
    if view.get("code") != 0:
        raise _vod_error(int(view.get("code") or 0), str(view.get("message") or ""))

    data = view.get("data") or {}
    pages = data.get("pages") or []
    parts = [
        {
            "index": int(p.get("page") or i + 1),
            "part_id": str(p.get("cid") or ""),
            "title": str(p.get("part") or (data.get("title") or "")),
            "duration_s": float(p.get("duration") or 0),
        }
        for i, p in enumerate(pages)
    ]
    if not parts:  # 极老的稿件可能没有 pages，只有 cid
        parts = [{
            "index": 1, "part_id": str(data.get("cid") or ""),
            "title": str(data.get("title") or ""),
            "duration_s": float(data.get("duration") or 0),
        }]

    # 画质档位：拿**第一个分集**问一次 playurl。不同 P 的可选档位可能不同，
    # 但把每个 P 都问一遍会让预览变慢（多 P 稿件可能几十个）——够用的近似。
    quality_options: list[str] = []
    try:
        play = await _bili_api(
            BILI_API_PLAYURL,
            {ids[0]: ids[1], "cid": parts[0]["part_id"], "fnval": 16, "fourk": 1, "qn": 127},
            cookies,
            proxy,
        )
        pdata = play.get("data") or {}
        quality_options = [str(x) for x in (pdata.get("accept_description") or [])]
    except Exception as e:  # 预览阶段拿不到档位不该让整个解析失败
        print(f"[bilibili-vod] 画质档位探测失败（不影响下载）: {e}", file=sys.stderr)

    is_login: bool | None = None
    if cookies:
        try:
            nav = await _bili_api(BILI_API_NAV, {}, cookies, proxy)
            is_login = bool((nav.get("data") or {}).get("isLogin"))
        except Exception:
            is_login = None

    page = _page_param(url)
    return {
        "id": req.get("id"),
        "ok": True,
        "platform": platform,
        "title": str(data.get("title") or ""),
        "uploader": str((data.get("owner") or {}).get("name") or ""),
        "parts": parts,
        "is_login": is_login,
        "quality_options": quality_options,
        "extra": {
            "bvid": data.get("bvid"),
            "aid": data.get("aid"),
            "total_parts": len(parts),
            # `?p=3` 的显式选择：UI 据此默认只勾这一集
            "selected_index": page,
            # 规范化后的地址（裸 BV/av 已补全，b23.tv 已跟随跳转）：
            # 宿主拿它当任务行的 url —— 存原始输入的话，"在浏览器打开"会打到
            # 一串 `BV1xx` 上，而 dedupe 也会把同一部作品的两种写法当成两个任务。
            "url": url,
        },
    }


def _vod_quality_label(pdata: dict, qn) -> str:
    """qn（平台整数码）→ 人类可读标签。**必须返回字符串**。

    2026-10-18 真机 BV1LgnG62EWe：该稿件没有 DASH，只能走 durl 单文件退化分支。
    那个分支当时写的是 `"quality": pdata.get("quality")` —— `quality` 是整数 64，
    而宿主协议里它是 `Option<String>`，于是整条下载 0.8 秒就失败在反序列化上，
    报错还是句看不懂的 "invalid type: integer `64`, expected a string"。

    规则：能按 `accept_quality` → `accept_description` 映射出标签就用标签，
    映射不到就 `str(qn)` —— 宁可显示 "64"，也不能让一个**展示字段**挂掉整次下载。
    """
    try:
        target = int(qn)
    except (TypeError, ValueError):
        return str(qn)

    descriptions = pdata.get("accept_description") or []
    qualities = pdata.get("accept_quality") or []
    for i, q in enumerate(qualities):
        try:
            if int(q) == target and i < len(descriptions):
                return str(descriptions[i])
        except (TypeError, ValueError):
            continue
    return str(target)


async def fetch_vod_streams(req: dict) -> dict:
    """取某一集的直链（**不落库**）。"""
    url = await _fetch_short_url(normalize_vod_url(req.get("url", "")), req.get("proxy"))
    ids = _bili_vod_ids(url)
    if ids is None:
        raise PluginError("UNSUPPORTED_URL", f"地址里找不到 BV 号或 av 号：{url}")
    part_id = str(req.get("part_id") or "").strip()
    if not part_id:
        raise PluginError("INTERNAL", "缺少 part_id（应先调 fetch_vod_meta 拿分集）")

    target = _bili_vod_qn(req.get("quality"))
    play = await _bili_api(
        BILI_API_PLAYURL,
        {ids[0]: ids[1], "cid": part_id, "fnval": 16, "fourk": 1, "qn": target},
        req.get("cookies"),
        req.get("proxy"),
    )
    if play.get("code") != 0:
        raise _vod_error(int(play.get("code") or 0), str(play.get("message") or ""))

    pdata = play.get("data") or {}
    dash = pdata.get("dash") or {}
    video, _, options = _pick_vod_video(dash.get("video") or [], target)
    if video is None:
        # 只能拿到一个 durl（老 FLV/MP4 稿件，没有 DASH）→ 退化成单文件流
        durls = pdata.get("durl") or []
        if not durls:
            raise PluginError(
                "PLATFORM_CHANGED",
                f"该稿件没有可用的 DASH/FLV 直链（qn={target}，平台可选 {options}）",
            )
        return {
            "id": req.get("id"), "ok": True,
            "video_urls": [d["url"] for d in durls if d.get("url")],
            "audio_urls": [],
            "http_headers": dict(BILI_VOD_HEADERS),
            "quality": _vod_quality_label(pdata, pdata.get("quality") or 0),
            "expire_hint_s": 7200,
        }

    audios = sorted(
        (a for a in (dash.get("audio") or []) if _vod_urls(a)),
        key=lambda a: int(a.get("bandwidth") or 0),
        reverse=True,
    )
    label = _vod_quality_label(pdata, video.get("id") or 0)
    return {
        "id": req.get("id"),
        "ok": True,
        "video_urls": _vod_urls(video),
        "audio_urls": _vod_urls(audios[0]) if audios else [],
        "video_codec": video.get("codecs"),
        "audio_codec": (audios[0].get("codecs") if audios else None),
        "width": video.get("width"),
        "height": video.get("height"),
        "http_headers": dict(BILI_VOD_HEADERS),
        "expire_hint_s": 7200,
        "quality": label,
        "extra": {"requested_qn": target, "actual_qn": video.get("id")},
    }
