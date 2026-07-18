export type RelaySnapshotProtocol = 'openai' | 'anthropic' | 'gemini'

export interface ExternalRelaySnapshotSite {
  sourceRank: number
  domain: string
  sourceScore: number
  reportCount: number
  lastCheckedAt: string
  protocols: RelaySnapshotProtocol[]
  sourceUrl: string
  sourceReportedLastCheckedAt?: string
  dateAdjusted?: true
  dataQualityNote?: string
}

const veridropSite = (
  site: Omit<ExternalRelaySnapshotSite, 'sourceUrl'>,
): ExternalRelaySnapshotSite => ({
  ...site,
  sourceUrl: `https://veridrop.org/leaderboard/${site.domain}`,
})

export const VERIDROP_RELAY_SNAPSHOT = {
  sourceName: 'Veridrop',
  sourceUrl: 'https://veridrop.org/leaderboard',
  sourceTemplateVersion: '20260713-leaderboard-top40-green-protocols-v1',
  capturedAt: '2026-07-18',
  methodology:
    'Veridrop 公示其综合排名会参考贝叶斯加权、严重问题比例、协议风险，并排除无效检测。以下仅保存公开页面快照，不在页面请求时实时抓取。',
  referenceMethod:
    '红榜参考保留公开榜单第 11 至 33 名中综合分不低于 70 的条目；按要求排除前 10 名，并将达到风险阈值或证据不足的条目移出红榜参考。',
  riskMethod:
    '风险观察由格物按固定规则从同一快照派生：Veridrop 综合分低于 70，且公开检测不少于 3 次。它不是 Veridrop 单独发布的黑榜，也不是永久质量或商业信誉定性。',
  excludedTopRanks: { from: 1, to: 10, count: 10 },
  riskThreshold: { sourceScoreBelow: 70, minimumReportCount: 3 },
  insufficientEvidence: [
    {
      sourceRank: 33,
      domain: 'ai.fengl.cc',
      sourceScore: 59,
      reportCount: 1,
      reason: '仅 1 次公开检测，未达到风险观察的最低样本数。',
    },
  ],
  referenceSites: [
    veridropSite({ sourceRank: 11, domain: 'linkai.shop', sourceScore: 84, reportCount: 22, lastCheckedAt: '2026-07-18', protocols: ['anthropic', 'openai'] }),
    veridropSite({ sourceRank: 12, domain: '9527code.com', sourceScore: 91, reportCount: 21, lastCheckedAt: '2026-07-14', protocols: ['anthropic', 'openai'] }),
    veridropSite({ sourceRank: 13, domain: 'zivv.pro', sourceScore: 89, reportCount: 11, lastCheckedAt: '2026-07-10', protocols: ['anthropic', 'gemini', 'openai'] }),
    veridropSite({ sourceRank: 14, domain: 'ssnaiyun.com', sourceScore: 93, reportCount: 30, lastCheckedAt: '2026-07-13', protocols: ['anthropic', 'openai'] }),
    veridropSite({ sourceRank: 15, domain: 'api.loomcode.cn', sourceScore: 92, reportCount: 81, lastCheckedAt: '2026-07-13', protocols: ['anthropic', 'openai'] }),
    veridropSite({ sourceRank: 16, domain: 'gwlink.cc', sourceScore: 93, reportCount: 14, lastCheckedAt: '2026-07-14', protocols: ['anthropic', 'openai'] }),
    veridropSite({ sourceRank: 17, domain: 'api.hohocode.ai', sourceScore: 89, reportCount: 26, lastCheckedAt: '2026-07-18', protocols: ['openai'] }),
    veridropSite({ sourceRank: 18, domain: 'api.touken.pro', sourceScore: 77, reportCount: 6, lastCheckedAt: '2026-06-27', protocols: ['anthropic'] }),
    veridropSite({ sourceRank: 19, domain: 'codereel.pro', sourceScore: 94, reportCount: 38, lastCheckedAt: '2026-07-17', protocols: ['anthropic', 'openai'] }),
    veridropSite({
      sourceRank: 20,
      domain: 'dragtokens.com',
      sourceScore: 87,
      reportCount: 1183,
      lastCheckedAt: '2026-07-18',
      sourceReportedLastCheckedAt: '2026-07-19',
      dateAdjusted: true,
      dataQualityNote: '源页面日期比快照日期晚 1 天，按快照日期展示并保留源值，可能来自时区边界。',
      protocols: ['anthropic', 'openai'],
    }),
    veridropSite({ sourceRank: 21, domain: 'dasuapi.com', sourceScore: 91, reportCount: 55, lastCheckedAt: '2026-07-17', protocols: ['openai'] }),
    veridropSite({ sourceRank: 22, domain: 'api.yuboar.com', sourceScore: 94, reportCount: 9, lastCheckedAt: '2026-06-26', protocols: ['anthropic', 'openai'] }),
    veridropSite({ sourceRank: 23, domain: 'niubiai.ai', sourceScore: 88, reportCount: 20, lastCheckedAt: '2026-07-07', protocols: ['openai'] }),
    veridropSite({ sourceRank: 24, domain: 'ai.furry.edu.gr', sourceScore: 79, reportCount: 27, lastCheckedAt: '2026-07-18', protocols: ['openai'] }),
    veridropSite({ sourceRank: 25, domain: 'api.sublyx.org', sourceScore: 87, reportCount: 2, lastCheckedAt: '2026-07-14', protocols: ['anthropic', 'openai'] }),
    veridropSite({ sourceRank: 27, domain: 'xbhuiz.com', sourceScore: 93, reportCount: 3, lastCheckedAt: '2026-06-22', protocols: ['anthropic', 'openai'] }),
    veridropSite({ sourceRank: 30, domain: 'officesai.top', sourceScore: 87, reportCount: 22, lastCheckedAt: '2026-07-16', protocols: ['anthropic', 'openai'] }),
    veridropSite({ sourceRank: 31, domain: 'www.bytecatcode.org', sourceScore: 74, reportCount: 23, lastCheckedAt: '2026-07-16', protocols: ['anthropic', 'openai'] }),
    veridropSite({ sourceRank: 32, domain: 'juxingai888.com', sourceScore: 75, reportCount: 19, lastCheckedAt: '2026-07-18', protocols: ['anthropic', 'gemini', 'openai'] }),
  ] satisfies ExternalRelaySnapshotSite[],
  riskSites: [
    veridropSite({ sourceRank: 26, domain: 'quotarouter.ai', sourceScore: 59, reportCount: 5, lastCheckedAt: '2026-07-04', protocols: ['openai'] }),
    veridropSite({ sourceRank: 28, domain: 'codexpp.com', sourceScore: 60, reportCount: 9, lastCheckedAt: '2026-07-16', protocols: ['openai'] }),
    veridropSite({ sourceRank: 29, domain: 'lucisapi.ai', sourceScore: 60, reportCount: 9, lastCheckedAt: '2026-07-18', protocols: ['openai'] }),
  ] satisfies ExternalRelaySnapshotSite[],
} as const

export const FIRST_PARTY_RELAY_SNAPSHOT = {
  name: 'nan.meta-api.vip',
  websiteUrl: 'https://nan.meta-api.vip/',
  disclosure: '格物自营推广',
  methodology: '格物检测器 standard 模式实测；未启用高成本长上下文测试。分数是本次快照，不代表永久表现。',
  tests: [
    {
      protocol: 'openai',
      model: 'gpt-5.6-sol',
      score: 90.6,
      verdict: '基本合格',
      checkedAt: '2026-07-18T07:46:16.314572Z',
      summary: '基础请求、模型一致性、函数调用和结构化输出通过；Token 计费与 usage 协议字段存在扣分，流式请求未通过。',
    },
    {
      protocol: 'anthropic',
      model: 'claude-fable-5',
      score: 98.3,
      verdict: '优秀',
      checkedAt: '2026-07-18T07:47:11.788737Z',
      summary: '身份、思维签名回放、模型一致性、结构化输出和协议规范均通过；Token 用量项为 85 分。',
    },
    {
      protocol: 'anthropic',
      model: 'claude-opus-4-8',
      score: 98.3,
      verdict: '优秀',
      checkedAt: '2026-07-18T07:47:40.778236Z',
      summary: '身份、思维签名回放、模型一致性、结构化输出和协议规范均通过；Token 用量项为 85 分。',
    },
  ] satisfies Array<{
    protocol: RelaySnapshotProtocol
    model: string
    score: number
    verdict: string
    checkedAt: string
    summary: string
  }>,
} as const