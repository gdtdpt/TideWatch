"""平台表 ⇄ plugin.json ⇄ probe 的**离线**一致性回归（不联网、不 spawn）。

跑法（在插件目录下）：

    ../../spikes/m0/runtime/python/python.exe -m unittest discover -s tests -v

为什么值得单独一个文件：
- 表驱动最容易烂的地方是**两边抄两份**：`platforms.py` 有自己的正则/子串，
  `plugin.json` 有宿主要用的 `url_patterns`/`platforms`。抄漏一处，症状是
  "插件明明支持这个平台，宿主却根本没把请求派给它" —— 极难排查，所以用测试钉死。
- `sample_url` 是 probe 的样本表：这次把它**入库**，就是为了不再出现
  "当年 51/51 是一次性实测、现在既跑不了也回归不了"（docs/06 M3.7）。
"""
import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
PLUGIN = HERE.parent
# 插件运行时把 site-packages 挂在 PYTHONPATH 上；测试自己照做，才能 import
sys.path.insert(0, str(PLUGIN / "site-packages"))
sys.path.insert(0, str(PLUGIN))

import adapters  # noqa: E402
import platforms  # noqa: E402


class ManifestSync(unittest.TestCase):
    """`plugin.json` 必须与 `platforms.py` 派生出来的完全一致。"""

    def setUp(self):
        self.manifest = json.loads((PLUGIN / "plugin.json").read_text(encoding="utf-8"))

    def test_url_patterns_equal_table(self):
        self.assertEqual(
            self.manifest["url_patterns"],
            platforms.MANIFEST_PATTERNS,
            "plugin.json 的 url_patterns 与 platforms.py 的表不一致"
            "（宿主预过滤用的是这里的**子串**）",
        )

    def test_platforms_equal_table(self):
        self.assertEqual(
            self.manifest["platforms"],
            [p.key for p in platforms.PLATFORM_ROWS],
        )

    def test_protocol_matches_adapter(self):
        self.assertEqual(self.manifest["protocol"], adapters.PROTOCOL_VERSION)

    def test_node_is_declared_optional_only_for_needy_platforms(self):
        """声明了 Node 就要说清 `affects_platforms`（`[]` = 当前平台集里无人依赖它）与 `reason`。

        ⚠️ 2026-10-13：`affects_platforms` **允许为空列表** —— 当前已接的抖音/B站都**不**需要
        Node（抖音取流签名走 `ab_sign`，纯 Python），声明只是给"以后按需后补的签名类平台"留口子。
        以前断言非空，会逼着为过测试而**谎报**受影响平台（正是本次要改的病根）。
        """
        optional = (self.manifest.get("requires") or {}).get("optional") or []
        for req in optional:
            if req.get("kind") == "node":
                self.assertIn(
                    "affects_platforms",
                    req,
                    "必须写清 affects_platforms（可以是空列表 = 当前平台集无平台依赖它）",
                )
                self.assertTrue(req.get("reason"), "必须写清为什么要 Node")


class SampleUrls(unittest.TestCase):
    """样本表：每个平台一条 URL，probe 认得出，且是**它自己**那一行。"""

    def test_every_row_has_sample_url_and_it_matches_its_own_row(self):
        for p in platforms.PLATFORM_ROWS:
            self.assertTrue(p.sample_url, f"{p.key} 没填 sample_url（probe 就没了样本）")
            self.assertEqual(
                adapters._match_platform(p.sample_url),
                p.key,
                f"{p.key} 的样本 {p.sample_url} 没被自己那行认出来",
            )

    def test_sample_urls_are_accepted_by_manifest_patterns(self):
        """样本必须能过宿主的预过滤 —— 否则宿主根本不会把请求派给这个插件。"""
        for p in platforms.PLATFORM_ROWS:
            low = p.sample_url.lower()
            self.assertTrue(
                any(pat.lower() in low for pat in p.manifest_patterns),
                f"{p.key} 的样本过不了 manifest_patterns 预过滤",
            )

    def test_probe_reports_platform_and_name(self):
        for p in platforms.PLATFORM_ROWS:
            got = adapters.probe({"id": "p1", "url": p.sample_url})
            self.assertTrue(got["ok"])
            self.assertEqual(got["platform"], p.key)
            self.assertEqual(got["platform_name"], p.name)

    def test_unknown_url_probes_null_not_error(self):
        """没认出来是**正常结果**（宿主据此说"暂不支持"），不该抛错。"""
        got = adapters.probe({"id": "p1", "url": "https://www.huya.com/52333"})
        self.assertTrue(got["ok"])
        self.assertIsNone(got["platform"])


class Evidence(unittest.TestCase):
    """表里每一行都得写清"什么时候、怎么验的"。"""

    def test_every_row_has_note(self):
        for p in platforms.PLATFORM_ROWS:
            self.assertTrue(p.note.strip(), f"{p.key} 没写实测证据（note）")

    def test_scope_is_douyin_and_bilibili_only(self):
        """2026-10-07 用户定案：只接抖音与 B站。范围变了**必须**同步 docs/06。"""
        self.assertEqual([p.key for p in platforms.PLATFORM_ROWS], ["douyin", "bilibili"])


class UnsupportedPlatform(unittest.TestCase):
    """`PLATFORM_UNSUPPORTED` 与"解析失败"必须分得开（M3.2 新增）。"""

    def test_unknown_platform_raises_platform_unsupported(self):
        with self.assertRaises(adapters.PluginError) as cm:
            adapters.resolve({"id": "x", "url": "https://www.huya.com/52333"})
        e = cm.exception
        self.assertEqual(e.code, "PLATFORM_UNSUPPORTED")
        self.assertFalse(e.retryable, "平台没接是**确定性**的，重试没有意义")

    def test_message_tells_user_what_is_supported(self):
        with self.assertRaises(adapters.PluginError) as cm:
            adapters.resolve({"id": "x", "url": "https://www.huya.com/52333"})
        msg = cm.exception.message
        self.assertIn("抖音", msg)
        self.assertIn("B站", msg)
        self.assertIn("插件", msg, "要告诉用户'怎么补'，而不只是'不行'")


if __name__ == "__main__":
    unittest.main()
