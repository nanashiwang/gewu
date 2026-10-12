export function RelaySteps({ site, hasResult = false }: { site?: any; hasResult?: boolean }) {
  const verified = ['verified', 'manual'].includes(site?.claimStatus)
  const approved = site?.status === 'approved'
  const current = !site ? 0 : !verified ? 1 : !approved ? 2 : 3
  const steps = [
    ['站点资料', '填写接口与检测模型'],
    ['验证域名', '添加 DNS TXT 记录'],
    ['提交审核', site?.status === 'pending' ? '已提交，等待人工审核' : site?.status === 'rejected' ? '根据反馈修改后重提' : site?.status === 'suspended' ? '已暂停，请联系运营复核' : '认领后提交人工审核'],
    ['检测与报告', hasResult ? '查看证据与历史记录' : approved && !site?.hasApiKey ? '请先配置检测 Key' : '审核通过后开始检测'],
  ]
  return <nav aria-label="站点接入进度"><ol className="relay-steps">{steps.map(([title, detail], index) => <li key={title} className={index < current ? 'is-complete' : index === current ? 'is-current' : ''} aria-current={index === current ? 'step' : undefined}><span className="relay-step-number" aria-hidden="true">{index < current ? '✓' : index + 1}</span><div><strong>{title}</strong><small>{detail}</small></div></li>)}</ol></nav>
}
