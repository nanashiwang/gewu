import { readFile } from 'node:fs/promises'
import path from 'node:path'
import Link from 'next/link'

export const metadata = { title: '用户功能说明 · 格物' }

const DOC_RELATIVE_PATH = 'docs/gewu-功能说明书.md'

type HeadingBlock = {
  type: 'heading'
  key: string
  level: 1 | 2 | 3
  text: string
  id: string
}

type MarkdownBlock =
  | HeadingBlock
  | { type: 'paragraph'; key: string; text: string }
  | { type: 'list'; key: string; items: string[] }
  | { type: 'quote'; key: string; text: string }
  | { type: 'hr'; key: string }

type DocSection = {
  heading: HeadingBlock
  blocks: MarkdownBlock[]
  summary: string
}

function createSlug(text: string, fallback: string) {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')

  return slug || fallback
}

function parseMarkdown(markdown: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const paragraphLines: string[] = []
  let listItems: string[] = []
  const slugCounts = new Map<string, number>()

  function nextKey(prefix: string) {
    return `${prefix}-${blocks.length}`
  }

  function uniqueSlug(base: string) {
    const count = slugCounts.get(base) || 0
    slugCounts.set(base, count + 1)
    return count === 0 ? base : `${base}-${count + 1}`
  }

  function flushParagraph() {
    if (paragraphLines.length === 0) return
    blocks.push({
      type: 'paragraph',
      key: nextKey('p'),
      text: paragraphLines.join(' '),
    })
    paragraphLines.length = 0
  }

  function flushList() {
    if (listItems.length === 0) return
    blocks.push({ type: 'list', key: nextKey('list'), items: listItems })
    listItems = []
  }

  for (const line of lines) {
    const trimmed = line.trim()

    if (!trimmed) {
      flushParagraph()
      flushList()
      continue
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed)
    if (heading) {
      flushParagraph()
      flushList()
      const text = heading[2].trim()
      const id = uniqueSlug(createSlug(text, `section-${blocks.length}`))
      blocks.push({
        type: 'heading',
        key: nextKey('h'),
        level: heading[1].length as 1 | 2 | 3,
        text,
        id,
      })
      continue
    }

    if (/^-{3,}$/.test(trimmed)) {
      flushParagraph()
      flushList()
      blocks.push({ type: 'hr', key: nextKey('hr') })
      continue
    }

    const listItem = /^[-*]\s+(.+)$/.exec(trimmed)
    if (listItem) {
      flushParagraph()
      listItems.push(listItem[1].trim())
      continue
    }

    if (trimmed.startsWith('>')) {
      flushParagraph()
      flushList()
      blocks.push({
        type: 'quote',
        key: nextKey('quote'),
        text: trimmed.replace(/^>\s?/, ''),
      })
      continue
    }

    flushList()
    paragraphLines.push(trimmed)
  }

  flushParagraph()
  flushList()
  return blocks
}

function buildSections(blocks: MarkdownBlock[]) {
  const sections: DocSection[] = []

  for (const block of blocks) {
    if (block.type === 'heading' && block.level === 2) {
      sections.push({ heading: block, blocks: [block], summary: '' })
      continue
    }

    const current = sections[sections.length - 1]
    if (!current) continue
    current.blocks.push(block)
  }

  return sections.map((section) => {
    const firstParagraph = section.blocks.find(
      (block) => block.type === 'paragraph',
    ) as { type: 'paragraph'; text: string } | undefined
    const firstQuote = section.blocks.find(
      (block) => block.type === 'quote',
    ) as { type: 'quote'; text: string } | undefined
    return {
      ...section,
      summary: (firstParagraph?.text || firstQuote?.text || '')
        .replace(/`/g, '')
        .slice(0, 86),
    }
  })
}

function renderBlock(block: MarkdownBlock) {
  if (block.type === 'hr') return null

  if (block.type === 'heading') {
    if (block.level === 1) {
      return (
        <h1
          key={block.key}
          id={block.id}
          className="scroll-mt-24 text-3xl font-bold tracking-tight"
        >
          {block.text}
        </h1>
      )
    }
    if (block.level === 2) {
      return (
        <h2
          key={block.key}
          id={block.id}
          className="scroll-mt-24 text-2xl font-semibold tracking-tight"
        >
          {block.text}
        </h2>
      )
    }
    return (
      <h3
        key={block.key}
        id={block.id}
        className="scroll-mt-24 text-base font-semibold text-[var(--accent)]"
      >
        {block.text}
      </h3>
    )
  }

  if (block.type === 'paragraph') {
    return (
      <p key={block.key} className="text-sm leading-7 text-[var(--muted)]">
        {block.text}
      </p>
    )
  }

  if (block.type === 'list') {
    return (
      <ul
        key={block.key}
        className="grid gap-2 text-sm text-[var(--muted)] sm:grid-cols-2"
      >
        {block.items.map((item, index) => (
          <li
            key={`${block.key}-${index}`}
            className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2"
          >
            {item}
          </li>
        ))}
      </ul>
    )
  }

  return (
    <blockquote
      key={block.key}
      className="rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3 text-sm text-[var(--text)]"
    >
      {block.text}
    </blockquote>
  )
}

export default async function DocsPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string }>
}) {
  const [{ section: selectedId }, markdown] = await Promise.all([
    searchParams,
    readFile(path.join(process.cwd(), DOC_RELATIVE_PATH), 'utf8'),
  ])
  const blocks = parseMarkdown(markdown)
  const sections = buildSections(blocks)
  const selectedSection = sections.find(
    (item) => item.heading.id === selectedId,
  )

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="card h-fit space-y-3 p-5 lg:sticky lg:top-24">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--faint)]">
              功能目录
            </p>
            <p className="mt-1 text-sm text-[var(--muted)]">
              点击左侧模块，右侧只展示该模块说明。
            </p>
          </div>
          <nav className="max-h-[70vh] space-y-1 overflow-y-auto pr-1 text-sm">
            <Link
              href="/docs"
              className={`block rounded-lg px-3 py-2 transition-colors ${
                !selectedSection
                  ? 'bg-[var(--accent)] text-white'
                  : 'text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--text)]'
              }`}
            >
              功能概览
            </Link>
            {sections.map((item) => (
              <Link
                key={item.heading.key}
                href={`/docs?section=${encodeURIComponent(item.heading.id)}`}
                className={`block rounded-lg px-3 py-2 transition-colors ${
                  selectedSection?.heading.id === item.heading.id
                    ? 'bg-[var(--accent)] text-white'
                    : 'text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--text)]'
                }`}
              >
                {item.heading.text}
              </Link>
            ))}
          </nav>
        </aside>

        {selectedSection ? (
          <article className="card space-y-5 p-5 sm:p-8">
            {selectedSection.blocks.map((block) => renderBlock(block))}
          </article>
        ) : (
          <article className="space-y-6">
            <div className="card space-y-3 p-5 sm:p-8">
              <h2 className="text-2xl font-semibold tracking-tight">
                先从你要做的事开始
              </h2>
              <p className="text-sm leading-7 text-[var(--muted)]">
                这份说明不把所有内容堆在一页。左侧选择模块后，右侧只显示对应说明；如果你还不知道从哪里开始，可以先看下面的常用路径。
              </p>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] p-4">
                  <div className="text-sm font-semibold">
                    我想找一个现成 Skill
                  </div>
                  <p className="mt-2 text-sm text-[var(--muted)]">
                    先跑必备 Skill；进入详情页后看
                    Passport、兼容证据和达标证书，再在线试用。
                  </p>
                  <Link
                    href="/skills?essential=1"
                    className="mt-3 inline-flex text-sm text-[var(--accent)] hover:underline"
                  >
                    先跑必备 Skill →
                  </Link>
                </div>
                <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] p-4">
                  <div className="text-sm font-semibold">
                    我想本地运行 Skill
                  </div>
                  <p className="mt-2 text-sm text-[var(--muted)]">
                    先看本地
                    Runner，再按设备授权完成登录；本地运行后可选择回传兼容报告。
                  </p>
                  <Link
                    href="/docs?section=本地-runner"
                    className="mt-3 inline-flex text-sm text-[var(--accent)] hover:underline"
                  >
                    查看 Runner →
                  </Link>
                </div>
                <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] p-4">
                  <div className="text-sm font-semibold">
                    我想发布自己的 Skill
                  </div>
                  <p className="mt-2 text-sm text-[var(--muted)]">
                    进入创作者发布，按字段填写能力说明、输入输出契约和模型建议；后续用失败库和
                    Adapter 建议持续维护。
                  </p>
                  <Link
                    href="/console/skills/new"
                    className="mt-3 inline-flex text-sm text-[var(--accent)] hover:underline"
                  >
                    发布 Skill →
                  </Link>
                </div>
                <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] p-4">
                  <div className="text-sm font-semibold">我想看历史结果</div>
                  <p className="mt-2 text-sm text-[var(--muted)]">
                    进入私人台账，可以查看输入输出、成本、可信兼容标记、重跑血缘和换模型对比。
                  </p>
                  <Link
                    href="/console/runs"
                    className="mt-3 inline-flex text-sm text-[var(--accent)] hover:underline"
                  >
                    打开私人台账 →
                  </Link>
                </div>
                <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] p-4">
                  <div className="text-sm font-semibold">
                    我想验签或做采购复核
                  </div>
                  <p className="mt-2 text-sm text-[var(--muted)]">
                    公开验签页集中复核分数快照、达标证书、证据快照和外锚包。
                  </p>
                  <Link
                    href="/verify"
                    className="mt-3 inline-flex text-sm text-[var(--accent)] hover:underline"
                  >
                    打开公开验签 →
                  </Link>
                </div>
                <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] p-4">
                  <div className="text-sm font-semibold">我想做企业治理</div>
                  <p className="mt-2 text-sm text-[var(--muted)]">
                    企业 Registry 支持批准
                    Skill、绑定策略、导出审计和查看组织内失败库。
                  </p>
                  <Link
                    href="/console/enterprise"
                    className="mt-3 inline-flex text-sm text-[var(--accent)] hover:underline"
                  >
                    打开企业 Registry →
                  </Link>
                </div>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {sections.map((item) => (
                <Link
                  key={item.heading.key}
                  href={`/docs?section=${encodeURIComponent(item.heading.id)}`}
                  className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4 transition-colors hover:border-[var(--accent)] hover:bg-[var(--panel-2)]"
                >
                  <div className="text-sm font-semibold text-[var(--text)]">
                    {item.heading.text}
                  </div>
                  <p className="mt-2 line-clamp-3 text-sm leading-6 text-[var(--muted)]">
                    {item.summary || '查看这个模块的功能说明。'}
                  </p>
                </Link>
              ))}
            </div>
          </article>
        )}
      </div>
    </div>
  )
}
