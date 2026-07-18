# 格物 —— Next.js(standalone) + Payload 多阶段镜像

# ---- 依赖 ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# ---- 构建 ----
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# 构建期占位（页面均 force-dynamic，构建不连库；运行时由 compose 注入真实 env）
ENV PAYLOAD_SECRET=build-time-placeholder
ENV DATABASE_URL=postgres://payload:payload@localhost:5432/gewu
RUN npm run build

# ---- 运行 ----
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN groupadd -g 1001 nodejs && useradd -u 1001 -g nodejs -m nextjs

# standalone 产物（含 traced node_modules，sharp 为 linux 二进制）
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/docs ./docs
COPY --from=builder /app/scripts/relay-cron.mjs ./scripts/relay-cron.mjs

# 媒体持久化目录：先以 root 建目录并赋权给 nextjs，再切非 root（否则 nextjs 对 /app 无写权限、上传会 EACCES）
RUN mkdir -p /app/media && chown -R nextjs:nodejs /app/media

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
