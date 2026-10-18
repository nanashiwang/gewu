# Package only the Linux standalone artifact built and tested in GitHub CI.
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
ARG GEWU_RELEASE_ID
LABEL org.opencontainers.image.title="格物账号平台" \
      org.opencontainers.image.source="https://github.com/nanashiwang/gewu" \
      org.opencontainers.image.revision="${GEWU_RELEASE_ID}" \
      org.gewu.report-access="1"
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
RUN groupadd -g 1001 nodejs && useradd -u 1001 -g nodejs -M nextjs
COPY --chown=nextjs:nodejs . ./
RUN mkdir -p /app/media /app/.next/cache && chown -R nextjs:nodejs /app/media /app/.next/cache
USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
    CMD node -e "fetch('http://127.0.0.1:3000/health',{signal:AbortSignal.timeout(3500)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
