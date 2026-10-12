"""Interface names shared by the detector and the account application."""
import json
from importlib.resources import files

WIRE_APIS = json.loads(files("relay_detector").joinpath("data/wire_apis.json").read_text())
GEMINI_NATIVE = {"interactions", "generate_content"}
CAPABILITY_APIS = {"responses", *GEMINI_NATIVE}


def resolve_wire_api(protocol: str, value: str | None = None) -> str:
    value = value or ("messages" if protocol == "anthropic" else "chat_completions")
    if value not in WIRE_APIS or protocol not in WIRE_APIS[value]["protocols"]:
        raise ValueError("检测协议与接口类型不匹配")
    return value


def capability_notes(wire_api: str) -> list[str]:
    label = WIRE_APIS[wire_api]["label"]
    return [
        f"本报告通过 {label} 检测；仅代表本次、此模型、此接口的已测能力。",
        "快速检测验证基础回复和流式完整性；标准增加结构化 JSON；完整增加本地函数调用往返。",
        "最多发送 2 / 3 / 5 次请求，每次输出上限 4096 tokens；无额外付费预检、自动重试或接口切换。",
        "不验证模型身份、长上下文或实际扣费；不与其他接口的分数直接比较，也不进入公共榜单。",
        "失败、未完成或用量缺失会明确标注；用量含上游报告的思考 tokens，不等于实际账单。",
    ]
