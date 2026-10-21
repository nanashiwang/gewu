// Only public configuration is sent to our own server. Never read the Key or URL.
(() => {
  const form = document.getElementById('detect-form');
  const directory = document.getElementById('provider-directory');
  if (!form && !directory) return;
  let statusPromise, statusLoadedAt = 0, latestStatus, selectedVendor, expiry;
  function loadStatus() {
    if (!statusPromise || Date.now() - statusLoadedAt > 300000) {
      statusLoadedAt = Date.now();
      statusPromise = fetch('/api/status/provider-status', {signal: AbortSignal.timeout(12000)})
      .then(response => { if (!response.ok) throw new Error('status unavailable'); return response.json(); })
      .catch(() => ({providers: {}}));
    }
    return statusPromise;
  }
  const stamp = value => value ? `来源采样：${new Date(value).toLocaleString('zh-CN', {hour12: false})}` : '无近期有效数据';
  function freshItem(item) {
    if (!item) return null;
    const age = Date.now() - Date.parse(item.checked_at);
    return Number.isFinite(age) && age >= 0 && age < 1800000 ? item
      : {...item, state: 'unknown', label: '状态未知', checked_at: null, note: '无近期有效数据，请查看原站；不代表厂商故障。'};
  }
  function paintStatus(data) {
    latestStatus = data;
    clearTimeout(expiry);
    const remaining = Object.values(data.providers).map(item => Date.parse(item.checked_at) + 1800000 - Date.now()).filter(ms => Number.isFinite(ms) && ms > 0);
    if (remaining.length) expiry = setTimeout(() => paintStatus(data), Math.min(...remaining) + 10);
    directory?.querySelectorAll('[data-provider]').forEach(card => {
      const item = freshItem(data.providers[card.dataset.provider]);
      card.querySelector('[data-status-label]').textContent = item?.label || '状态未知 · 当前来源未覆盖或不可用';
      card.querySelector('[data-status-time]').textContent = stamp(item?.checked_at);
    });
    if (form && selectedVendor) {
      const item = freshItem(data.providers[selectedVendor]);
      provider.textContent = item ? `${item.label} · ${stamp(item.checked_at)}` : '状态未知 · 当前聚合源未覆盖此厂商或暂不可用。';
      links.replaceChildren();
      if (item) {
        providerScope.textContent = `${item.scope} ${item.note}`;
        links.append(link('官方原始通告 ↗', item.url));
        if (item.extra_url) links.append(link(`${item.extra_label} ↗`, item.extra_url));
      }
      links.append(link('AI Status Hub ↗', 'https://study8677.github.io/ai-status-hub/'));
    }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && latestStatus) paintStatus(latestStatus); });
  if (directory) loadStatus().then(paintStatus);
  if (!form) return;
  const model = document.getElementById('model');
  const summary = document.getElementById('scope-summary');
  const checks = document.getElementById('scope-checks');
  const baseline = document.getElementById('scope-baseline');
  const note = document.getElementById('scope-note');
  const provider = document.getElementById('provider-summary');
  const providerScope = document.getElementById('provider-scope');
  const links = document.getElementById('provider-links');
  let generation = 0, pending;
  function link(label, url) {
    const element = document.createElement('a');
    element.textContent = label;
    element.href = url; element.target = '_blank'; element.rel = 'noopener noreferrer';
    return element;
  }
  async function update() {
    const current = ++generation;
    selectedVendor = null;
    pending?.abort();
    checks.replaceChildren(); links.replaceChildren();
    baseline.textContent = ''; note.textContent = '';
    provider.textContent = '选择模型后查看对应厂商的外部通告。';
    providerScope.textContent = '外部状态不参与评分，也不能证明当前中转线路正常。';
    if (!model.value) {
      summary.textContent = '选择模型后显示计划项目与官方基线状态。此处不发送模型请求。';
      return;
    }
    summary.textContent = '正在读取检测范围…';
    const protocol = form.dataset.endpoint.endsWith('/openai') ? 'openai' : form.dataset.endpoint.endsWith('/gemini') ? 'gemini' : 'anthropic';
    const params = new URLSearchParams({protocol, model: model.value, mode: document.getElementById('mode').value});
    const wire = document.getElementById('wire-api') || document.getElementById('gemini-wire-api');
    if (wire) params.set('wire_api', wire.value);
    const suite = document.getElementById('responses-suite');
    if (suite && !suite.disabled) params.set('responses_suite', suite.value);
    for (const name of ['include_long_context', 'include_long_context_extreme']) {
      const input = document.getElementById(name);
      params.set(name, String(!!input?.checked && !input.disabled));
    }
    pending = new AbortController();
    const controller = pending;
    const timeout = setTimeout(() => controller.abort(), 7000);
    try {
      const response = await fetch(`/api/status/detection-scope?${params}`, {signal: controller.signal});
      if (!response.ok) throw new Error('scope unavailable');
      const data = await response.json();
      if (generation !== current) return;
      summary.textContent = `计划检查 ${data.checks.length} 项；以实际完成的证据为准。`;
      checks.replaceChildren(...data.checks.map(check => {
        const item = document.createElement('li');
        item.textContent = check.label + (check.observation ? ' · 仅观察' : '');
        return item;
      }));
      baseline.textContent = data.baseline.state === 'available'
        ? '有已审核的同配置基线；检测完成后还需核对实际计分范围，才能确认可比。'
        : '暂无可用于本配置的官方基线；可以检测接口表现，暂不能给出相对官方的结论。';
      note.textContent = data.note;
      const status = await loadStatus();
      if (generation !== current) return;
      selectedVendor = data.vendor;
      paintStatus(status);
    } catch {
      if (generation !== current) return;
      summary.textContent = '检测范围暂时无法读取，请查看模型目录与来源说明；这不代表接口故障。';
    } finally { clearTimeout(timeout); }
  }
  // Existing picker code updates native options on discovery and vendor changes.
  new MutationObserver(() => queueMicrotask(update)).observe(model, {childList: true});
  form.addEventListener('change', event => {
    if (['model', 'mode', 'wire-api', 'gemini-wire-api', 'model-vendor', 'include_long_context', 'include_long_context_extreme'].includes(event.target.id)) queueMicrotask(update);
  });
  update();
})();
