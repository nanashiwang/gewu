# Baselines

This directory holds **historical reference reports** collected by running
`bench.sh` against the official Anthropic API (`https://api.anthropic.com`)
with a real `sk-ant-...` key.

Each file `<model>_<mode>.json` is the raw output of `gewu detect`
in that mode, against that model, on the official API. These represent what
the detector observed at capture time. An official endpoint is not guaranteed
to score 100; a failure can also identify a detector assumption that needs review.

## Purpose

Current `evidence-v2` excludes identity claims, writing style and knowledge
questions from the quality score. Output-length CV and opaque signature length
are observations, not evidence of substitution. Signature evidence requires
successful original replay and a verified rejection of the tampered control.

Direct comparison requires matching model, protocol, interface, mode, scoring
and probe versions, and the same executed scored probes and weights. Both
reports need valid evidence and timezone-aware timestamps within 30 days;
future timestamps and inconsistent totals are rejected before computing diffs.
Quick and standard never fall back to a full-mode baseline.

The existing JSON files retain their original scores and bytes. Files lacking
the required metadata cannot calibrate current reports. New public scores
remain ineligible until a comparable baseline is available; approved historical
evidence is kept separate. Protocol differences do not prove a model's identity.

## Refreshing

With explicit permission to spend the official API key's quota, re-run
`./bench.sh` whenever:
- A new Claude snapshot ships (e.g. Haiku 4.5 → 4.6)
- Anthropic API behavior changes (e.g. a field's shape is updated)
- Detector logic changes meaningfully

```bash
OFFICIAL_KEY=sk-ant-...  ./bench.sh
```

After running on the deploy host, copy the output back into this directory:

```bash
scp -r root@<host>:/tmp/baselines/*.json gewu/detector/data/baselines/
```

## Files

- `claude-opus-4-7_full.json`   — Opus 4.7, full mode (10/10 detectors)
- `claude-sonnet-4-6_full.json` — Sonnet 4.6, full mode
- `claude-haiku-4-5_full.json`  — Haiku 4.5, full mode
- `claude-opus-4-6_full.json`   — Opus 4.6 (legacy), full mode

(other modes / models can coexist using the same `<model>_<mode>.json` naming)
