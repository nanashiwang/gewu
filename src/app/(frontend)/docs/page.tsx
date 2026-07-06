import { readFile } from 'node:fs/promises'
import path from 'node:path'
import Link from 'next/link'

export const metadata = { title: '功能说明书 · 衡术 Hengshu' }

const DOC_RELATIVE_PATH = 'docs/衡术-功能说明书.md'

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
    blocks.push({ type: 'paragraph', key: nextKey('p'), text: paragraphLines.join(' ') })
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
      blocks.push({ type: 'quote', key: nextKey('quote'), text: trimmed.replace(/^>\s?/, '') })
      continue
    }

    flushList()
    paragraphLines.push(trimmed)
  }

  flushParagraph()
  flushList()
  return blocks
}

function renderBlock(block: MarkdownBlock, hiddenKeys: Set<string>) {
  if (hiddenKeys.has(block.key)) return null

  if (block.type === 'heading') {
    if (block.level === 1) {
      return (
        <h1 key={block.key} id={block.id} className="scroll-mt-24 text-3xl font-bold tracking-tight">
          {block.text}
        </h1>
      )
    }
    if (block.level === 2) {
      return (
        <h2
          key={block.key}
          id={block.id}
          className="scroll-mt-24 border-t border-[var(--border)] pt-8 text-xl font-semibold tracking-tight first:border-t-0 first:pt-0"
        >
          {block.text}
        </h2>
      )
    }
    return (
      <h3 key={block.key} id={block.id} className="scroll-mt-24 text-base font-semibold text-[var(--accent)]">
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
      <ul key={block.key} className="grid gap-2 text-sm text-[var(--muted)] sm:grid-cols-2">
        {block.items.map((item, index) => (
          <li key={`${block.key}-${index}`} className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2">
            {item}
          </li>
        ))}
      </ul>
    )
  }

  if (block.type === 'quote') {
    return (
      <blockquote
        key={block.key}
        className="rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3 text-sm text-[var(--muted)]"
      >
        {block.text}
      </blockquote>
    )
  }

  return <hr key={block.key} className="border-[var(--border)]" />
}

export default async function DocsPage() {
  const markdown = await readFile(path.join(process.cwd(), DOC_RELATIVE_PATH), 'utf8')
  const blocks = parseMarkdown(markdown)
  const firstTitle = blocks.find((block): block is HeadingBlock => block.type === 'heading' && block.level === 1)
  const summary = blocks.find((block) => block.type === 'quote' || block.type === 'paragraph')
  const sections = blocks.filter((block): block is HeadingBlock => block.type === 'heading' && block.level === 2)
  const hiddenKeys = new Set([firstTitle?.key, summary?.key].filter(Boolean) as string[])

  return (
    <div className="space-y-8">
      <section className="overflow-hidden rounded-3xl border border-[var(--border)] bg-gradient-to-br from-[var(--hero-from)] to-[var(--hero-to)] p-6 shadow-[var(--shadow)] sm:p-8">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl space-y-4">
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[var(--accent-2)]">Hengshu Docs</p>
            <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{firstTitle?.text || '衡术功能说明书'}</h1>
            {summary && 'text' in summary ? <p className="text-base text-[var(--muted)]">{summary.text}</p> : null}
          </div>
          <div className="flex flex-wrap gap-2 text-xs text-[var(--faint)]">
            <span className="rounded-full border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5">
              来源：{DOC_RELATIVE_PATH}
            </span>
            <Link href="/admin" className="rounded-full border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 hover:text-[var(--accent)]">
              管理后台
            </Link>
          </div>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="card h-fit space-y-3 p-5 lg:sticky lg:top-24">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--faint)]">目录</p>
            <p className="mt-1 text-sm text-[var(--muted)]">随仓库文档重新构建后同步更新。</p>
          </div>
          <nav className="max-h-[70vh] space-y-1 overflow-y-auto pr-1 text-sm">
            {sections.map((section) => (
              <a
                key={section.key}
                href={`#${section.id}`}
                className="block rounded-lg px-3 py-2 text-[var(--muted)] transition-colors hover:bg-[var(--panel-2)] hover:text-[var(--text)]"
              >
                {section.text}
              </a>
            ))}
          </nav>
        </aside>

        <article className="card space-y-5 p-5 sm:p-8">{blocks.map((block) => renderBlock(block, hiddenKeys))}</article>
      </div>
    </div>
  )
}
