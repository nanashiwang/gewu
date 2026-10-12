"""User-facing next steps based on transport evidence, never model self-talk."""

from relay_detector.core.assessment import assess_report
from relay_detector.core.evidence_errors import contains_auth_failure


def job_feedback(job) -> dict[str, str]:
    def feedback(code: str, title: str, message: str) -> dict[str, str]:
        return {"code": code, "title": title, "message": message}

    if job.status == "cancelled":
        return feedback("cancelled", "检测已取消", "已停止继续检测。已发送的请求仍可能产生费用；重新检测需主动提交。")
    if job.status == "interrupted":
        return feedback("interrupted", "检测已中断", "服务重启中断了本次检测，已完成证据已保留。系统不会自动重跑，请主动重新提交。")
    report = job.report or {}
    raw_rows = report.get("results")
    rows = [row for row in raw_rows if isinstance(row, dict)] if isinstance(raw_rows, list) else []
    # Only inspect error/transport fields. A model replying “401” or “rate
    # limit” in response_text must not change the error category.
    fragments = [str(job.error or ""), str(report.get("run_error") or "")]

    def collect(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if key in {"error", "error_message", "status_code", "response_body", "exception_type"} and isinstance(child, (str, int)):
                    fragments.append(str(child))
                elif isinstance(child, (dict, list)):
                    collect(child)
        elif isinstance(value, list):
            for child in value:
                collect(child)

    collect(rows)
    text = "\n".join(fragments).lower()
    if contains_auth_failure(rows) or any(term in text for term in ("401", "invalid_api_key", "authenticationerror")):
        return feedback("authentication", "鉴权未通过，暂不计分", "请检查 API Key、额度和模型访问权限，再主动重新检测。这不代表模型造假。")
    if any(term in text for term in ("429", "rate_limit", "rate limit", "too many requests")):
        return feedback("rate_limit", "上游限流，检测未完成", "请等待限流窗口恢复后主动重试，避免连续提交。")
    if any(term in text for term in ("model_not_found", "model not found", "model_not_available", "unknown model", "no such model")):
        return feedback("model_unavailable", "目标模型不可用", "请确认该站点实际提供的模型 ID 和当前 Key 的权限，然后重新选择模型。")
    if any(term in text for term in ("timeout", "timed out", "超时")):
        return feedback("timeout", "请求超时，检测未完成", "请稍后主动重试，或先选择快速检测。超时不能证明模型造假。")
    if job.status == "error" or not assess_report(report)["score_usable"]:
        return feedback("incomplete", "证据不足，暂不计分", "请查看已完成证据及错误项目，确认入口与协议后再主动重新检测。")
    if assess_report(report)["counts"]["fail"]:
        return feedback("protocol", "存在异常，需复核", "请查看未通过项目的字段级证据；协议或能力异常不等于已经证明模型造假。")
    return feedback("complete", "检测完成", "报告仅反映本次已完成的检测项目。")
