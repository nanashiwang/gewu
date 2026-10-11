import type { ReactNode } from 'react'

export const metadata = {
  title: '中转站管理 · 格物',
  description: '认领自己的中转站，提交审核并查看检测记录。',
  robots: { index: false, follow: false },
}

export default function RelayAccountLayout({
  children,
}: {
  children: ReactNode
}) {
  return children
}
