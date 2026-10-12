"""ConsistencyDetector — DESIGN.md §3.4.

Every response.model must match the requested model. This checks a declared
protocol field, not model identity. Completion-length variation is recorded
as an observation only. Quick mode sends one call; other modes keep the
existing three-call sample unless the model restricts sampling parameters.
"""

from __future__ import annotations

from ....core.scoring_policy import sampling_observation

from ..config import models_match
from ....core.models import DetectorResult, Mode
from .base import ActiveDetector


PROBE_PROMPT = (
    "Reply in 30 words explaining what HTTP status 418 means. "
    "Do not include any preamble."
)
MAX_TOKENS = 100
RUNS_FULL = 3
RUNS_QUICK = 1


class ConsistencyDetector(ActiveDetector):
    name = "consistency"
    display_name = "模型一致性"
    weight = 10.0

    async def run(self, client, model: str) -> DetectorResult:
        is_quick = self.config is not None and self.config.mode == Mode.QUICK
        sampling_restricted = model.replace(".", "-").startswith((
            "claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5",
        ))
        n_runs = RUNS_QUICK if is_quick or sampling_restricted else RUNS_FULL

        responses = []
        try:
            for _ in range(n_runs):
                _req, resp, _h, _lat = await client.messages_create(
                    model=model,
                    max_tokens=MAX_TOKENS,
                    temperature=0,
                    messages=[{"role": "user", "content": PROBE_PROMPT}],
                )
                responses.append(resp)
        except Exception as e:  # noqa: BLE001
            return self._result("error", 0.0, error=str(e))

        first = responses[0]
        response_model = first.get("model") or ""
        response_models = [r.get("model") or "" for r in responses]
        match = all(models_match(model, value) for value in response_models)
        model_score = 100.0 if match else 0.0

        details: dict = {
            "request_model": model,
            "response_model": response_model,
            "response_models": response_models,
            "score_basis": "仅检查每次响应声明的型号是否匹配请求；字段匹配不证明模型身份。",
            "model_match": match,
            "n_runs": n_runs,
        }

        if n_runs > 1:
            output_tokens = [
                _safe_int(r.get("usage", {}).get("output_tokens"))
                for r in responses
            ]
            details["output_tokens_seq"] = output_tokens
            details.update(sampling_observation(output_tokens))
        else:
            details["stability_label"] = "not_applicable_sampling_restricted" if sampling_restricted else "skipped_quick_mode"

        score = model_score
        status = "pass" if score >= 70 else "fail"
        return self._result(status, score, details)


def _safe_int(v) -> int:
    return v if isinstance(v, int) and not isinstance(v, bool) else 0
