FROM python:3.12-slim-bookworm
ARG GEWU_RELEASE_ID=development
LABEL org.opencontainers.image.title="格物检测服务" \
      org.opencontainers.image.source="https://github.com/nanashiwang/gewu" \
      org.opencontainers.image.revision="${GEWU_RELEASE_ID}"
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    PYTHONPATH=/opt/gewu-detector/src:/opt/gewu-detector \
    GEWU_RELEASE_ID=${GEWU_RELEASE_ID} \
    GEWU_JOBS_DIR=/opt/gewu-detector/web_data/jobs \
    GEWU_WISHLIST_PATH=/opt/gewu-detector/web_data/wishlist.txt \
    GEWU_BASELINES_DIR=/opt/gewu-detector/data/baselines
WORKDIR /opt/gewu-detector
RUN apt-get update && apt-get install -y --no-install-recommends fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 gewu && useradd --uid 10001 --gid gewu --no-create-home gewu
COPY pyproject.toml constraints.txt README.md LICENSE ./
COPY src/relay_detector ./src/relay_detector
COPY web ./web
RUN python -m pip install --no-cache-dir --constraint constraints.txt '.[web]' \
    && mkdir -p web_data/jobs data/baselines report_fonts \
    && chown -R gewu:gewu web_data
USER 10001:10001
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import json,urllib.request; r=json.load(urllib.request.urlopen('http://127.0.0.1:8765/readyz',timeout=3)); assert r.get('ok') is True and r.get('storage_writable') is True"
CMD ["python", "-m", "uvicorn", "web.server:app", "--host", "127.0.0.1", "--port", "8765", "--workers", "1", "--proxy-headers", "--forwarded-allow-ips", "127.0.0.1"]
