const { test } = require('node:test');
const assert = require('node:assert/strict');
const sync = require('./catalog-review.cjs');
const report = { verified_on: '2026-10-11', review_overdue: false, official_identifier_changes: { openai: { added: ['gpt-new'], removed: [] } } };
function fixture(issues = []) {
  const calls = [];
  const summary = { addHeading() { return this; }, addRaw() { return this; }, async write() {} };
  return { calls, args: { report, context: { repo: { owner: 'example', repo: 'catalog' } }, core: { summary }, github: {
    paginate: async () => issues,
    rest: { issues: { listForRepo() {}, create: async p => calls.push(['create', p]), update: async p => calls.push(['update', p]) } },
  } } };
}
test('create once; repeated reports do not update or reopen acknowledged issues', async () => {
  const first = fixture(); await sync(first.args);
  assert.equal(first.calls[0][0], 'create');
  for (const state of ['open', 'closed']) {
    const next = fixture([{ number: 7, state, body: first.calls[0][1].body }]);
    await sync(next.args); assert.deepEqual(next.calls, []);
  }
});
test('a changed report reopens the existing issue instead of creating another', async () => {
  const first = fixture(); await sync(first.args);
  const next = fixture([{ number: 7, state: 'closed', body: first.calls[0][1].body }]);
  next.args.report = { ...report, review_overdue: true };
  await sync(next.args);
  assert.equal(next.calls[0][0], 'update');
  assert.equal(next.calls[0][1].issue_number, 7);
  assert.equal(next.calls[0][1].state, 'open');
});
test('clean reports close pending reviews; API errors are not silently ignored', async () => {
  const next = fixture([{ number: 7, state: 'open', body: '<!-- gewu-official-catalog-review -->' }]);
  next.args.report = { ...report, official_identifier_changes: {} };
  await sync(next.args); assert.equal(next.calls[0][1].state, 'closed');
  const failed = fixture(); failed.args.github.paginate = async () => { throw new Error('permission denied'); };
  await assert.rejects(sync(failed.args), /permission denied/);
});
