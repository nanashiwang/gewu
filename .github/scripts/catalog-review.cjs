const { createHash } = require('node:crypto');

module.exports = async function syncCatalogReview({ github, context, core, report }) {
  const marker = '<!-- gewu-official-catalog-review -->';
  const changes = report.official_identifier_changes;
  const pending = report.review_overdue || Object.keys(changes).length > 0;
  await core.summary.addHeading('官方模型目录巡检')
    .addRaw(pending ? '官网目录有变化或需要定期复核；详见目录复核 Issue。' : '目录与快照一致，复核未过期。')
    .write();
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    ...context.repo, state: 'all', creator: 'github-actions[bot]', per_page: 100,
  });
  const issue = issues.find(item => !item.pull_request && item.body?.startsWith(marker));
  if (!pending) {
    if (issue?.state === 'open') {
      await github.rest.issues.update({ ...context.repo, issue_number: issue.number, state: 'closed' });
    }
    return;
  }
  const digest = createHash('sha256').update(JSON.stringify(report)).digest('hex');
  const fingerprint = `<!-- report:${digest} -->`;
  if (issue?.body?.includes(fingerprint)) return;
  const body = `${marker}\n${fingerprint}\n官网抓取结果需要人工复核。候选名称变化不等于模型正式上线或下线；请核对官网与产品能力后再更新目录和快照。\n\n相同报告不重复通知；关闭此事项表示已知晓，出现新变化时会重新打开。\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\``;
  // GitHub limits issue bodies to 65,536 characters. Fail visibly instead of truncating evidence.
  if (body.length > 60000) throw new Error('目录变化报告过大，请检查官网解析器');
  const payload = { ...context.repo, title: '官方模型目录需要复核', body };
  if (issue) {
    await github.rest.issues.update({ ...payload, issue_number: issue.number, state: 'open' });
  } else {
    await github.rest.issues.create(payload);
  }
};
