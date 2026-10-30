"""streamget 平台插件 — stdio JSON 协议（docs/04）。

平台清单在 `platforms.py`（表驱动，新增平台 = 加一行；当前只接抖音与 B站）。
stdout 只允许协议 JSON，任何库的打印都被重定向到 stderr。
"""
import asyncio
import json
import sys

_PROTO_STDOUT = None  # 协议专用 stdout（被重定向前保存）


def _emit(obj: dict) -> None:
    _PROTO_STDOUT.write(
        json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n"
    )
    _PROTO_STDOUT.flush()


def main() -> None:
    global _PROTO_STDOUT
    _PROTO_STDOUT = sys.stdout
    sys.stdout = sys.stderr  # 库内的 print/进度一律进 stderr

    import adapters  # 重定向后再 import，防止导入期打印污染 stdout

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            _emit(
                {
                    "id": None,
                    "ok": False,
                    "error": {
                        "code": "INTERNAL",
                        "message": f"bad request json: {e}",
                        "retryable": False,
                    },
                }
            )
            continue

        req_id = req.get("id")
        action = req.get("action")
        try:
            if action == "probe":
                _emit(adapters.probe(req))
            elif action == "resolve":
                _emit(adapters.resolve(req))
            elif action == "fetch_vod_meta":
                # 点播的两个 action 是**异步**的（内部 await HTTP）；直播的 resolve 自己
                # 建事件循环，点播这两条走 asyncio.run —— 两者互不嵌套，不会打架。
                _emit(asyncio.run(adapters.fetch_vod_meta(req)))
            elif action == "fetch_vod_streams":
                _emit(asyncio.run(adapters.fetch_vod_streams(req)))
            else:
                _emit(
                    {
                        "id": req_id,
                        "ok": False,
                        "error": {
                            "code": "INTERNAL",
                            "message": f"unknown action: {action!r}",
                            "retryable": False,
                        },
                    }
                )
        except adapters.PluginError as e:  # 已分类的业务错误
            _emit(e.response(req_id))
        except Exception as e:  # 兜底分类
            code, msg, retryable, retry_after = adapters.classify_exception(e)
            _emit(adapters.error_response(req_id, code, msg, retryable, retry_after))


if __name__ == "__main__":
    main()
