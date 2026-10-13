"""Preview the actual runner selection without creating a client or API call."""
from importlib import import_module

from relay_detector.baselines import baseline_status
from relay_detector.core.models import ExecutionConfig, Mode
from relay_detector.model_catalog import model_vendor
from relay_detector.wire_apis import CAPABILITY_APIS, resolve_wire_api


def detection_scope(protocol: str, model: str, mode: str, wire_api: str | None = None,
                    include_long_context: bool = False, include_long_context_extreme: bool = False) -> dict:
    wire = resolve_wire_api(protocol, wire_api)
    cfg = ExecutionConfig.for_mode(Mode(mode))
    cfg.openai_wire_api = wire if protocol == "openai" else "chat_completions"
    cfg.gemini_wire_api = wire if protocol == "gemini" else "chat_completions"
    cfg.include_long_context = include_long_context
    cfg.include_long_context_extreme = include_long_context_extreme
    module = import_module(f"relay_detector.protocols.{protocol}")
    runner = module.build_runner(None, module.build_detectors(cfg.mode), cfg)
    selected = runner._select_detectors(model)
    checks = [{"name": d.name, "label": d.display_name, "observation": d.evidence_role == "observation"}
              for d in selected if d.name != "long_context" or include_long_context or include_long_context_extreme]
    baseline = baseline_status(protocol, model, mode, wire)
    return {"protocol": protocol, "wire_api": wire, "vendor": model_vendor(model), "checks": checks,
            "baseline": baseline, "capability_only": wire in CAPABILITY_APIS,
            "note": "计划项目不等于已经通过；权限、响应及模型能力会影响实际完成情况。第三方状态不替代检测证据，分数不证明模型身份。"}
