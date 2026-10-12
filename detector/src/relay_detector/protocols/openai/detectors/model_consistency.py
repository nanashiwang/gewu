"""Check declared model fields; record output lengths without a quality penalty."""

from __future__ import annotations

from ....core.scoring_policy import sampling_observation

from ....core.models import DetectorResult, Mode
from ..config import models_match
from ....model_catalog import bare_model
from .base import ActiveDetector


class ModelConsistencyDetector(ActiveDetector):
    name = "model_consistency"
    display_name = "模型一致性"
    weight = 15.0

    async def run(self, client, model: str) -> DetectorResult:
        quick = self.config is not None and self.config.mode == Mode.QUICK
        variable_sampling = bare_model(model).startswith(("gpt-6-astra", "gpt-6.1-sol"))
        runs = 1 if quick or variable_sampling else 3
        responses = []
        try:
            for _ in range(runs):
                _req, resp, _h, _lat = await client.chat_completions_create(
                    model=model,
                    max_completion_tokens=60,
                    temperature=0,
                    messages=[
                        {
                            "role": "user",
                            "content": "In one sentence, explain HTTP status 418.",
                        }
                    ],
                )
                responses.append(resp)
        except Exception as e:  # noqa: BLE001
            return self._result("error", 0.0, error=str(e))

        response_model = str(responses[0].get("model") or "")
        response_models = [str(r.get("model") or "") for r in responses]
        match = all(models_match(model, value) for value in response_models)
        score = 100.0 if match else 0.0
        details = {
            "request_model": model,
            "response_model": response_model,
            "response_models": response_models,
            "score_basis": "仅检查每次响应声明的型号是否匹配请求；字段匹配不证明模型身份。",
            "model_match": match,
            "n_runs": runs,
        }
        if runs == 1:
            details["stability_label"] = "not_applicable_sampling_restricted" if variable_sampling else "skipped_quick_mode"
        else:
            tokens = [
                _safe_int((r.get("usage") or {}).get("completion_tokens"))
                for r in responses
            ]
            details["completion_tokens_seq"] = tokens
            details.update(sampling_observation(tokens))
        return self._result("pass" if score >= 70 else "fail", score, details)


def _safe_int(value) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0
