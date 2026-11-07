"""adapters 的画质映射与可用档位抽取 —— **离线**回归（不联网、不 spawn）。

跑法（在插件目录下）：

    ../../spikes/m0/runtime/python/python.exe -m unittest discover -s tests -v

平台表 / `plugin.json` / probe 样本的一致性回归在同目录 `test_platforms.py`。

为什么值得单独锁：
- `_bili_quality_options` 决定 UI 下拉里出现什么 —— 给出"选不了 / 录不出"的档位
  比不给更糟（av1 实测录出来没有视频轨）；
- `_streamget_quality` 是**防崩护栏**：streamget 的 `fetch_stream_url` 把数字当
  *下标* 用（`list(keys)["400"]`），一旦把 qn 码原样喂进去就是 `IndexError`，
  整次解析退化成可重试的 `INTERNAL`，症状是"这个任务一直解析失败"。
"""
import asyncio
import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
PLUGIN = HERE.parent
# 插件运行时把 site-packages 挂在 PYTHONPATH 上；测试自己照做，才能 import adapters
sys.path.insert(0, str(PLUGIN / "site-packages"))
sys.path.insert(0, str(PLUGIN))

import adapters  # noqa: E402

FIXTURES = HERE / "fixtures"

#: streamget 词表（site-packages/.../bilibili/live_stream.py 的 `video_quality_options`）。
#: 喂给 streamget 的值**必须**落在这个集合里，否则它会 `.get(v, '10000')` 静默降级；
#: 更糟的是数字形态会走 `list(keys)[int(v)]` 直接越界。
STREAMGET_VOCAB = {"OD", "BD", "UHD", "HD", "SD", "LD"}


def load(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def playurl_of(doc: dict) -> dict:
    return ((doc.get("data") or {}).get("playurl_info") or {}).get("playurl") or {}


def synthetic(levels: dict[int, list[str]]) -> dict:
    """按 {qn: [codec...]} 造一份最小 playurl（用于边界用例）。"""
    stream = [{"protocol_name": "http_stream", "format": []}]
    for qn, codecs in levels.items():
        stream[0]["format"].append({
            "format_name": "flv",
            "codec": [
                {"codec_name": c, "current_qn": qn, "base_url": f"/{qn}/{c}.flv",
                 "url_info": [{"host": "https://cdn.example.invalid", "extra": ""}]}
                for c in codecs
            ],
        })
    return {"stream": stream}


class QualityOptions(unittest.TestCase):
    def test_real_room6_offers_only_really_available_levels(self):
        """真实 fixture（2026-10-07 房间 6 在播、未登录）：只该出现原画与超清。

        ⚠️ 这条锁的是**诚实**：房间 6 没有 400/150 线路，下拉里就不许出现"蓝光/高清"；
        10000 只有 hevc（av1 被 `_BILI_CODEC_DENY` 剔除），但它仍应出现 —— 有 hevc 就录得出来。
        """
        opts = adapters._bili_quality_options(playurl_of(load("bili_playinfo_room6.json")))
        self.assertEqual(opts, ["原画", "超清"])
        for absent in ("蓝光", "高清", "流畅", "4K", "杜比"):
            self.assertNotIn(absent, opts, f"{absent} 该房间根本拿不到")

    def test_av1_only_level_is_not_offered(self):
        """某档位**只有 av1** → 不给它：录出来没有视频轨（rc 仍是 0，静默废文件）。"""
        pd = synthetic({400: ["av1"], 250: ["avc"], 150: ["av1"]})
        self.assertEqual(adapters._bili_quality_options(pd), ["超清"])

    def test_missing_url_info_is_not_offered(self):
        """没有可用地址的线路不算"可选"（选中了也录不了）。"""
        pd = synthetic({400: ["avc"], 250: ["avc"]})
        pd["stream"][0]["format"][0]["codec"][0]["url_info"] = []
        self.assertEqual(adapters._bili_quality_options(pd), ["超清"])

    def test_logged_in_levels_are_labelled(self):
        """登录后能拿到的 4K/杜比也要有中文标签（否则下拉里是裸数字）。"""
        pd = synthetic({30000: ["avc"], 20000: ["hevc"], 10000: ["avc"], 80: ["avc"]})
        self.assertEqual(adapters._bili_quality_options(pd), ["杜比", "4K", "原画", "流畅"])

    def test_empty_or_broken_payload_yields_empty(self):
        for bad in (None, {}, {"stream": None}, {"stream": [{"format": []}]}):
            self.assertEqual(adapters._bili_quality_options(bad), [])


class TargetQn(unittest.TestCase):
    def test_four_accepted_spellings(self):
        cases = {
            "OD": 10000, "BD": 400, "UHD": 250, "HD": 150, "SD": 80, "LD": 80,
            "od": 10000,                                    # 词表大小写不敏感
            "0": 10000, "1": 400, "2": 250, "3": 150,       # streamget 的数字下标写法
            "原画": 10000, "蓝光": 400, "超清": 250, "4K": 20000, "杜比": 30000,
            "10000": 10000, "400": 400, "20000": 20000,     # 裸 qn 码
            None: 10000, "": 10000, "   ": 10000,           # 缺省 = 原画
            "乱写": 10000,                                   # 不认识的宁可高不可低
        }
        for raw, want in cases.items():
            self.assertEqual(adapters._bili_target_qn(raw), want, f"输入 {raw!r}")

    def test_labels_from_options_round_trip(self):
        """下拉里给出的标签必须能原样回环成 qn —— 否则"改选后生效"就是空话。"""
        pd = synthetic({30000: ["avc"], 10000: ["hevc"], 400: ["avc"], 80: ["avc"]})
        for label in adapters._bili_quality_options(pd):
            qn = adapters._bili_target_qn(label)
            self.assertEqual(adapters.BILI_QN_NAMES.get(qn), label)


class StreamgetGuard(unittest.TestCase):
    def test_never_passes_something_streamget_would_index_by(self):
        """任何输入都只能落进 streamget 的六个词表值 —— 数字会被当**下标**用。"""
        for raw in ["400", "10000", "30000", "原画", "超清", "OD", "0", "5", "乱写", None]:
            got = adapters._streamget_quality(raw)
            self.assertIn(got, STREAMGET_VOCAB, f"输入 {raw!r} → {got!r} 不在词表内")
            self.assertFalse(got.isdigit(), "数字形态会被 streamget 当下标")

    def test_higher_levels_collapse_to_od(self):
        """streamget 自己最高只到 10000：4K/杜比 也送给它 OD（真正的高档由新接口拿）。"""
        for raw in ["原画", "4K", "杜比", "10000", "30000", "0", None]:
            self.assertEqual(adapters._streamget_quality(raw), "OD", f"输入 {raw!r}")


class QualityActual(unittest.TestCase):
    """回给宿主的"实际画质"—— 平台静默降级时这是唯一的真相来源。

    没有它，未登录请求原画只拿到高清这件事完全不可见：`code` 是 0、不报错，
    用户只会觉得"录出来怎么这么糊"。
    """

    def test_degraded_when_below_room_ceiling(self):
        bili = {"qn": 150, "codec": "avc", "format": "flv", "options": ["原画", "高清"]}
        self.assertEqual(
            adapters._bili_quality_actual(bili, "原画"),
            {"qn": 150, "label": "高清", "codec": "avc", "format": "flv",
             "requested": "原画", "degraded": True},
        )

    def test_room_ceiling_is_not_a_downgrade(self):
        """房间最高只有蓝光：请求原画拿到蓝光不算降级（上不去 ≠ 被降级）。"""
        bili = {"qn": 400, "codec": "hevc", "format": "flv", "options": ["蓝光", "流畅"]}
        got = adapters._bili_quality_actual(bili, None)
        self.assertFalse(got["degraded"])
        # 用户没显式设档位时，requested 报"本房间最高"，才解释得通
        self.assertEqual(got["requested"], "蓝光")

    def test_explicit_request_is_echoed(self):
        bili = {"qn": 250, "codec": "avc", "format": "ts", "options": ["原画", "超清"]}
        got = adapters._bili_quality_actual(bili, "超清")
        self.assertEqual((got["requested"], got["degraded"]), ("超清", False))

    def test_generic_platform_never_claims_degradation(self):
        """判断不了就别谎报：其它平台一律 degraded=False，qn 为 None。"""

        class Sd:
            quality = "720p"

        got = adapters._generic_quality_actual(Sd(), None)
        assert got is not None
        self.assertEqual((got["qn"], got["label"], got["degraded"]), (None, "720p", False))
        self.assertIsNone(got["requested"])

    def test_generic_platform_without_quality_is_null(self):
        class Sd:
            quality = None

        self.assertIsNone(adapters._generic_quality_actual(Sd(), "720p"))


if __name__ == "__main__":
    unittest.main()


# ---------------------------------------------------------------------------
# 点播（M6.1）：单集下载的两个 action —— 同样**离线**，HTTP 全部打桩
# ---------------------------------------------------------------------------


class VodUrlNormalization(unittest.TestCase):
    """裸 BV/av 号与 `?p=` 必须在**插件侧**解释（前端不该认识平台标识）。"""

    def test_bare_ids_become_full_urls(self):
        self.assertEqual(
            adapters.normalize_vod_url("BV1GJ411x7h7"),
            "https://www.bilibili.com/video/BV1GJ411x7h7",
        )
        self.assertEqual(
            adapters.normalize_vod_url("av170001"),
            "https://www.bilibili.com/video/av170001",
        )
        # 完整 URL 原样返回（含 ?p=3）
        full = "https://www.bilibili.com/video/BV1GJ411x7h7?p=3"
        self.assertEqual(adapters.normalize_vod_url(full), full)

    def test_ids_are_extracted_from_both_forms(self):
        self.assertEqual(
            adapters._bili_vod_ids("https://www.bilibili.com/video/BV1GJ411x7h7/?p=2"),
            ("bvid", "BV1GJ411x7h7"),
        )
        self.assertEqual(
            adapters._bili_vod_ids("https://www.bilibili.com/video/av170001"),
            ("aid", "170001"),
        )
        # 直播间地址不是点播
        self.assertIsNone(adapters._bili_vod_ids("https://live.bilibili.com/6"))

    def test_page_param(self):
        self.assertEqual(adapters._page_param("https://x/video/BV1GJ411x7h7?p=3"), 3)
        self.assertIsNone(adapters._page_param("https://x/video/BV1GJ411x7h7"))
        self.assertIsNone(adapters._page_param("https://x/video/BV1GJ411x7h7?p=abc"))

    def test_probe_reports_kind(self):
        vod = adapters.probe({"id": "1", "url": "https://www.bilibili.com/video/BV1GJ411x7h7"})
        self.assertEqual((vod["platform"], vod["kind"]), ("bilibili", "vod"))
        bare = adapters.probe({"id": "1", "url": "BV1GJ411x7h7"})
        self.assertEqual(bare["kind"], "vod", "裸 BV 号也属于点播")
        live = adapters.probe({"id": "1", "url": "https://live.bilibili.com/6"})
        self.assertEqual((live["platform"], live["kind"]), ("bilibili", "live"))
        self.assertIsNone(adapters.probe({"id": "1", "url": "https://www.huya.com/1"})["platform"])


class VodQuality(unittest.TestCase):
    def test_labels_map_to_vod_qn_not_live_qn(self):
        """⚠️ 点播的 qn 与直播**不是同一套**（直播 4K=20000，点播 4K=120）。"""
        cases = {
            "auto": 127, "": 127, None: 127, "乱写": 127,
            "120": 120, "80": 80,
            "4K 超清": 120, "1080P60 高帧率": 116, "1080P 高清": 80,
            "720P 高清": 64, "480P 清晰": 32,
        }
        for raw, want in cases.items():
            self.assertEqual(adapters._bili_vod_qn(raw), want, f"输入 {raw!r}")


class VodStreamPicking(unittest.TestCase):
    def _video(self, qn, codecs, **kw):
        return {"id": qn, "codecs": codecs, "base_url": f"https://cdn/{qn}.m4s", **kw}

    def test_never_above_requested_and_prefers_quality(self):
        videos = [self._video(80, "avc1.64001F"), self._video(64, "hev1.1.6")]
        picked, _, _ = adapters._pick_vod_video(videos, 80)
        self.assertEqual(picked["id"], 80)

    def test_av1_is_excluded_like_live(self):
        videos = [self._video(80, "av01.0.08M"), self._video(64, "avc1.64001F")]
        picked, _, _ = adapters._pick_vod_video(videos, 127)
        self.assertEqual(picked["id"], 64, "av1 不保证 ffmpeg copy 可用")

    def test_avc_wins_tie_but_quality_wins_over_codec(self):
        videos = [self._video(80, "hev1.1.6"), self._video(80, "avc1.64001F")]
        picked, _, _ = adapters._pick_vod_video(videos, 127)
        self.assertEqual(picked["codecs"], "avc1.64001F")
        # 只有 hevc 的更高档 → 仍取更高档（画质优先于编码）
        videos = [self._video(116, "hev1.1.6"), self._video(80, "avc1.64001F")]
        picked, _, _ = adapters._pick_vod_video(videos, 127)
        self.assertEqual(picked["id"], 116)

    def test_urls_accept_both_key_styles_and_backups(self):
        self.assertEqual(
            adapters._vod_urls({"baseUrl": "https://a", "backupUrl": ["https://b"]}),
            ["https://a", "https://b"],
        )
        self.assertEqual(
            adapters._vod_urls({"base_url": "https://a", "backup_url": ["https://b", None]}),
            ["https://a", "https://b"],
        )
        self.assertEqual(adapters._vod_urls({}), [])


class VodActions(unittest.TestCase):
    """两个 action 的**离线**回归：把 `_bili_api` 换掉，不联网。"""

    VIEW = {
        "code": 0,
        "data": {
            "bvid": "BV1GJ411x7h7",
            "aid": 170001,
            "title": "测试稿件",
            "owner": {"name": "UP主"},
            "cid": 111,
            "duration": 400,
            "pages": [
                {"page": 1, "cid": 111, "part": "第一集", "duration": 200},
                {"page": 2, "cid": 222, "part": "第二集", "duration": 200},
            ],
        },
    }

    def _stub(self, mapping):
        calls = []

        async def fake_api(path, params, cookies, proxy):
            calls.append((path, params, cookies))
            for key, value in mapping.items():
                if key in path:
                    return value
            raise AssertionError(f"未打桩的接口：{path}")

        self._orig = adapters._bili_api
        adapters._bili_api = fake_api
        self.addCleanup(lambda: setattr(adapters, "_bili_api", self._orig))
        return calls

    def _play(self, payload):
        async def run():
            return payload
        return run

    def test_meta_lists_parts_and_real_quality_options(self):
        self._stub({
            "web-interface/view": self.VIEW,
            "player/playurl": {
                "code": 0,
                "data": {
                    "accept_description": ["1080P 高清", "480P 清晰"],
                    "accept_quality": [80, 32],
                },
            },
        })
        got = asyncio.run(adapters.fetch_vod_meta({
            "id": "v1", "url": "https://www.bilibili.com/video/BV1GJ411x7h7?p=2",
        }))
        self.assertTrue(got["ok"])
        self.assertEqual(got["title"], "测试稿件")
        self.assertEqual(got["uploader"], "UP主")
        self.assertEqual([p["index"] for p in got["parts"]], [1, 2])
        self.assertEqual(got["parts"][1]["part_id"], "222")
        self.assertEqual(got["quality_options"], ["1080P 高清", "480P 清晰"])
        # `?p=2` → UI 默认只勾这一集
        self.assertEqual(got["extra"]["selected_index"], 2)

    def test_missing_cid_falls_back_to_single_part(self):
        view = json.loads(json.dumps(self.VIEW))
        view["data"].pop("pages")
        self._stub({"web-interface/view": view, "player/playurl": {"code": 0, "data": {}}})
        got = asyncio.run(adapters.fetch_vod_meta({
            "id": "v1", "url": "BV1GJ411x7h7",
        }))
        self.assertEqual(len(got["parts"]), 1)
        self.assertEqual(got["parts"][0]["part_id"], "111")

    def test_deleted_video_is_deterministic_error(self):
        self._stub({"web-interface/view": {"code": -404, "message": "啥都木有"}})
        with self.assertRaises(adapters.PluginError) as cm:
            asyncio.run(adapters.fetch_vod_meta({
                "id": "v1", "url": "https://www.bilibili.com/video/BV1GJ411x7h7",
            }))
        self.assertEqual(cm.exception.code, "UNSUPPORTED_URL")
        self.assertFalse(cm.exception.retryable, "稿件没了重试没有意义")

    def test_streams_returns_dash_pair_with_headers(self):
        self._stub({
            "player/playurl": {
                "code": 0,
                "data": {
                    "accept_description": ["1080P 高清", "480P 清晰"],
                    "accept_quality": [80, 32],
                    "dash": {
                        "video": [
                            {"id": 32, "codecs": "avc1.64001E",
                             "base_url": "https://cdn/480.m4s",
                             "backup_url": ["https://cdn2/480.m4s"]},
                            {"id": 80, "codecs": "hev1.1.6",
                             "baseUrl": "https://cdn/1080.m4s",
                             "backupUrl": ["https://cdn2/1080.m4s"]},
                        ],
                        "audio": [
                            {"id": 30280, "codecs": "mp4a.40.2", "bandwidth": 320000,
                             "base_url": "https://cdn/a-hi.m4s"},
                            {"id": 30216, "codecs": "mp4a.40.2", "bandwidth": 64000,
                             "baseUrl": "https://cdn/a-lo.m4s"},
                        ],
                    },
                },
            },
        })
        got = asyncio.run(adapters.fetch_vod_streams({
            "id": "v2", "url": "https://www.bilibili.com/video/BV1GJ411x7h7",
            "part_id": "111", "quality": "auto",
        }))
        self.assertEqual(got["video_urls"][0], "https://cdn/1080.m4s")
        self.assertEqual(got["video_urls"][1], "https://cdn2/1080.m4s")
        # 音频取最高码率，并带备线
        self.assertEqual(got["audio_urls"], ["https://cdn/a-hi.m4s"])
        self.assertEqual((got["width"], got["height"]), (None, None))
        self.assertEqual(got["quality"], "1080P 高清")
        # CDN 校验 Referer + UA，缺一即 403（2026-10-07 实测）
        self.assertIn("Referer", got["http_headers"])
        self.assertIn("User-Agent", got["http_headers"])

    def test_streams_requires_part_id(self):
        self._stub({})
        with self.assertRaises(adapters.PluginError) as cm:
            asyncio.run(adapters.fetch_vod_streams({
                "id": "v2", "url": "https://www.bilibili.com/video/BV1GJ411x7h7",
            }))
        self.assertIn("part_id", cm.exception.message)

    def test_meta_rejects_unrelated_url(self):
        with self.assertRaises(adapters.PluginError) as cm:
            asyncio.run(adapters.fetch_vod_meta({
                "id": "v1", "url": "https://live.bilibili.com/6",
            }))
        self.assertEqual(cm.exception.code, "PLATFORM_UNSUPPORTED")

    def test_durl_fallback_quality_is_a_string(self):
        """无 DASH 的稿件（2026-10-18 真机 BV1LgnG62EWe）走 durl 单文件分支。

        当时 `quality` 直接塞了 `pdata["quality"]` 的整数 64，而宿主协议是
        `Option<String>` → 反序列化失败，整条下载 0.8 秒就挂，报错还是一句
        "invalid type: integer `64`, expected a string"。
        展示字段必须是字符串：档位表能对上就用标签。
        """
        self._stub({
            "player/playurl": {
                "code": 0,
                "data": {
                    "quality": 64,
                    "accept_quality": [112, 80, 64, 32, 16],
                    "accept_description": [
                        "高清 1080P+", "高清 1080P", "高清 720P", "清晰 480P", "流畅 360P",
                    ],
                    "dash": {"video": [], "audio": []},
                    "durl": [{"url": "https://cdn.example/1.mp4"}],
                },
            },
        })
        st = asyncio.run(adapters.fetch_vod_streams({
            "id": "v3", "url": "https://www.bilibili.com/video/BV1GJ411x7h7",
            "part_id": "111", "quality": "auto",
        }))
        self.assertIsInstance(st["quality"], str)
        self.assertEqual(st["quality"], "高清 720P")
        self.assertEqual(st["video_urls"], ["https://cdn.example/1.mp4"])
        # durl = 音视频合一的单文件，没有独立音轨
        self.assertEqual(st["audio_urls"], [])
        self.assertEqual(st["http_headers"]["Referer"], adapters.BILI_VOD_HEADERS["Referer"])

    def test_durl_quality_without_a_label_falls_back_to_the_code(self):
        """档位表对不上时退化成 `"64"` —— 能显示就行，**不能是整数**。"""
        self._stub({
            "player/playurl": {
                "code": 0,
                "data": {
                    "quality": 64,
                    "accept_quality": [],
                    "accept_description": [],
                    "durl": [{"url": "https://cdn.example/2.mp4"}],
                },
            },
        })
        st = asyncio.run(adapters.fetch_vod_streams({
            "id": "v4", "url": "https://www.bilibili.com/video/BV1GJ411x7h7",
            "part_id": "111", "quality": "auto",
        }))
        self.assertEqual(st["quality"], "64")
        self.assertIsInstance(st["quality"], str)


class ClassifyExceptionTest(unittest.TestCase):
    """异常 → (code, message, retryable)。

    锁的是**别把不知道的事说成结论**（2026-10-25 真机）：streamget 的
    `_get_web_stream_data` 在 `data` 为空且没有 `prompts` 时抛
    `"VR live is not supported"`，那是**兜底文案** —— 房间下播同样会让 `data` 变空。
    照抄成"VR 直播间不支持"会让用户对着一场正常直播的报错误以为房间类型不受支持。
    """

    def test_vr_fallback_message_reports_the_evidence_not_a_guess(self):
        from adapters import classify_exception

        code, message, retryable, retry_after = classify_exception(
            Exception("VR live is not supported")
        )
        self.assertEqual(code, "UNSUPPORTED_URL")
        self.assertIs(retryable, False)
        self.assertIsNone(retry_after)
        self.assertIn("未返回直播数据", message, "应如实描述拿到的事实")
        self.assertNotIn("VR", message, "不能把兜底文案当成结论")

    def test_mobile_path_variant_matches_too(self):
        """app 路径抛的是 `{url} VR live is not supported`（带前缀），同一套处置。"""
        from adapters import classify_exception

        code, message, retryable, _ = classify_exception(
            Exception("https://live.douyin.com/123 VR live is not supported")
        )
        self.assertEqual(code, "UNSUPPORTED_URL")
        self.assertIs(retryable, False)
        self.assertIn("未返回直播数据", message)

    def test_room_visibility_restriction_is_not_a_bug(self):
        """主播设了观看范围 → RESTRICTED，半小时后再试。

        2026-11-03 真机：抖音连续 46 次每 30 秒返回这句话，全被兜底成 INTERNAL，
        任务卡一直显示"出错"，用户以为程序坏了。
        """
        from adapters import classify_exception

        code, message, retryable, retry_after = classify_exception(
            Exception("你不在主播设置的可见范围内，无法进入TA的直播间")
        )
        self.assertEqual(code, "RESTRICTED")
        self.assertIs(retryable, True)
        self.assertEqual(retry_after, 1800, "撞门没用，等半小时")
        self.assertIn("可见范围", message)

    def test_ended_live_is_a_state_not_an_error(self):
        """抖音下播抛异常而不是返回空 → NOT_LIVE，不能记成 INTERNAL。

        2026-11-04 实测：下播期间每 30 秒记一条"出错"，一天 61 条噪音。
        """
        from adapters import classify_exception

        for raw in ("直播已结束", "Exception: 直播已结束", "该主播已下播"):
            code, _message, retryable, retry_after = classify_exception(Exception(raw))
            self.assertEqual(code, "NOT_LIVE", f"输入 {raw!r}")
            self.assertIs(retryable, True)
            self.assertIsNone(retry_after)

    def test_risk_control_still_wins_over_ended_live(self):
        """同时提到风控和下播时，风控优先（退避 60s 而不是当成正常下播）。"""
        from adapters import classify_exception

        code, _message, _retryable, retry_after = classify_exception(
            Exception("直播已结束 it triggered risk control")
        )
        self.assertEqual(code, "RATE_LIMITED")
        self.assertEqual(retry_after, 60)
