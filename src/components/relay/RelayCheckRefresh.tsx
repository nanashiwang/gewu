'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

export function RelayCheckRefresh({ active }: { active: boolean }) {
  const router = useRouter()
  const [expired, setExpired] = useState(false)
  useEffect(() => {
    if (!active) return
    setExpired(false)
    const end = Date.now() + 10 * 60_000
    const timer = window.setInterval(() => {
      if (Date.now() >= end) {
        window.clearInterval(timer)
        setExpired(true)
      } else if (document.visibilityState === 'visible') {
        router.refresh()
      }
    }, 15_000)
    return () => window.clearInterval(timer)
  }, [active, router])
  if (!active) return null
  return <div className="relay-progress" role="status"><p>{expired ? '已暂停页面自动刷新，检测任务仍由服务端处理。' : '检测已提交。服务端约每分钟同步一次结果；此页会自动更新，离开页面不会取消任务。'}</p><button type="button" className="btn btn-secondary" onClick={() => router.refresh()}>刷新状态</button></div>
}
