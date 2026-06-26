import Link from 'next/link'

export const metadata = { title: '开发者文档 · 衡术 Hengshu' }

export default function DocsPage() {
  return (
    <div className="prose-invert max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold">开发者文档</h1>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Skill 即 API</h2>
        <p className="text-sm text-[var(--muted)]">
          每个已发布的 Skill 都会暴露一个可调用端点。在前台登录后（基于 Cookie 鉴权）即可调用：
        </p>
        <pre className="overflow-x-auto rounded-lg bg-[var(--panel-2)] p-4 text-xs">
{`POST /v1/skills/{slug}/run
Content-Type: application/json
Cookie: payload-token=...

{
  "input": { "topic": "秋季护肤", "style": "温暖" },
  "routeMode": "balanced"   // cheap | quality | fast | balanced
}`}
        </pre>
        <p className="text-sm text-[var(--muted)]">返回示例：</p>
        <pre className="overflow-x-auto rounded-lg bg-[var(--panel-2)] p-4 text-xs">
{`{
  "ok": true,
  "model": "deepseek-chat",
  "routeMode": "balanced",
  "mocked": false,
  "cost": 0.0012,
  "latencyMs": 2300,
  "tokens": { "prompt": 64, "completion": 117, "total": 181 },
  "formatValid": true,
  "output": "...",
  "outputJson": { "titles": ["..."] },
  "skillRunId": "..."
}`}
        </pre>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">模型网关联动</h2>
        <p className="text-sm text-[var(--muted)]">
          衡术通过 OpenAI 兼容接口调用模型网关（<code>MODEL_GATEWAY_BASE_URL</code> /{' '}
          <code>MODEL_GATEWAY_KEY</code>）。未配置时运行会返回带 <code>MOCK</code> 标记的模拟输出，便于先行体验。
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">管理后台</h2>
        <p className="text-sm text-[var(--muted)]">
          内容、用户、审核、邀请码、贡献值、悬赏等均在 Payload 后台管理：
          <Link href="/admin" className="ml-1 text-[var(--accent)]" target="_blank">
            /admin
          </Link>
        </p>
      </section>
    </div>
  )
}
