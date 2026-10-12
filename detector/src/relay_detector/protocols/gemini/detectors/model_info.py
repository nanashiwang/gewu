"""Declared model fields and output-length observations.

In OpenAI-compat mode, Gemini relays return the model id in `response.model`.
The relay's job is to faithfully echo (or canonically map) the requested model.
Completion lengths describe the sample only; neither length nor a matching
model field proves which upstream model generated the response.
"""

from __future__ import annotations

from ....core.scoring_policy import sampling_observation

from ....core.models import DetectorResult, Mode
from ..config import models_match
from .base import ActiveDetector
from .utils import int_value


class ModelInfoDetector(ActiveDetector):
    name = "model_info"
    display_name = "模型响应形状"
    weight = 15.0

    async def run(self, client, model: str) -> DetectorResult:
        quick = self.config is not None and self.config.mode == Mode.QUICK
        runs = 1 if quick else 3
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

        first = responses[0]
        response_model = str(first.get("model") or "")
        response_models = [str(r.get("model") or "") for r in responses]
        match = all(models_match(model, value) for value in response_models)
        score = 100.0 if match else 0.0
        details = {
            "request_model": model,
            "response_model": response_model,
            "response_models": response_models,
            "score_basis": "仅检查每次响应声明的型号是否匹配请求；字段匹配不证明模型身份。",
            "model_match": match,
            "response_id": first.get("id"),
            "response_object": first.get("object"),
            "n_runs": runs,
        }
        if runs == 1:
            details["stability_label"] = "skipped_quick_mode"
        else:
            tokens = [
                int_value((r.get("usage") or {}).get("completion_tokens")) or 0
                for r in responses
            ]
            details["completion_tokens_seq"] = tokens
            details.update(sampling_observation(tokens))
        return self._result("pass" if score >= 70.0 else "fail", score, details)
