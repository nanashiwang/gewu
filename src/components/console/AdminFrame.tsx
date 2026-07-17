'use client'

import { useCallback, useEffect, useRef } from 'react'

// 1) 隐藏 Payload 自带左导航/汉堡/顶栏，修正 grid 内容列宽，并给内容加内边距（避免紧贴边框的压迫感）
const HIDE_CSS = `
aside.nav{display:none !important;}
.template-default__nav-toggler-wrapper{display:none !important;}
.template-default__wrap{grid-column:1 / -1 !important;padding:26px 30px 34px !important;}
.app-header{display:none !important;}
`

// 2) 把 Payload 主题令牌映射到控制台调色板（与 globals.css 对齐），消除色差割裂
const PALETTE = {
  dark: {
    bg: '#0b0d13',
    panel: '#151922',
    panel2: '#1c212d',
    panelHover: '#1f2533',
    border: '#262d3b',
    borderStrong: '#353d4e',
    text: '#eaedf3',
    muted: '#9099aa',
    faint: '#6b7384',
  },
  light: {
    bg: '#f5f7fa',
    panel: '#ffffff',
    panel2: '#f1f4f8',
    panelHover: '#eef2f7',
    border: '#e4e8ee',
    borderStrong: '#d2d8e2',
    text: '#1a1f2b',
    muted: '#5c6675',
    faint: '#8b94a3',
  },
}

function themeCss(mode: 'light' | 'dark') {
  const p = PALETTE[mode]
  return `:root{
    --theme-bg:${p.bg} !important;
    --theme-elevation-0:${p.panel} !important;
    --theme-elevation-50:${p.panel2} !important;
    --theme-elevation-100:${p.panelHover} !important;
    --theme-elevation-150:${p.border} !important;
    --theme-elevation-200:${p.borderStrong} !important;
    --theme-input-bg:${p.panel} !important;
    --theme-border-color:${p.border} !important;
    --theme-text:${p.text} !important;
  }
  html,body{background:${p.bg} !important;}
  .template-default,.template-default__wrap{background:${p.bg} !important;}
  `
}

export function AdminFrame({ src }: { src: string }) {
  const ref = useRef<HTMLIFrameElement>(null)

  const inject = useCallback(() => {
    try {
      const doc = ref.current?.contentDocument
      if (!doc) return // 跨域等异常时静默放弃
      const mode = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
      // 让 iframe 内 Payload 自身明暗跟随控制台
      doc.documentElement.setAttribute('data-theme', mode)
      let style = doc.getElementById('gewu-admin-embed') as HTMLStyleElement | null
      if (!style) {
        style = doc.createElement('style')
        style.id = 'gewu-admin-embed'
        doc.head.appendChild(style)
      }
      style.textContent = HIDE_CSS + themeCss(mode)
    } catch {
      /* 同源策略异常时忽略 */
    }
  }, [])

  useEffect(() => {
    inject()
    // 控制台切换明暗（修改 <html data-theme>）时，同步重注入
    const obs = new MutationObserver(inject)
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [inject])

  return (
    <iframe
      ref={ref}
      src={src}
      onLoad={inject}
      title="后台"
      className="h-[80vh] w-full overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg)]"
    />
  )
}
