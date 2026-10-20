// One click submits the existing detection API and opens that job's report URL.
// No Key is persisted, placed in a URL, or sent just because a field changed.
(() => {
  const form = document.getElementById('quick-check');
  if (!form?.hasAttribute('data-direct-detection')) return;
  const el = id => document.getElementById(id);
  const base = el('quick-base-url'), key = el('quick-api-key');
  const vendor = el('quick-vendor'), model = el('quick-model');
  const mode = el('quick-mode'), wire = el('quick-wire');
  const start = el('quick-start'), load = el('quick-load-models');
  const errorBox = el('quick-check-error'), hint = el('quick-model-hint');
  const catalog = JSON.parse(vendor.dataset.catalog || '[]');
  const modeLabels = {quick: '快速检测', standard: '标准检测', full: '完整检测'};
  const specs = {
    claude: {endpoint: '/api/detect/claude', wires: [['messages', 'Messages']], defaultWire: 'messages'},
    openai: {endpoint: '/api/detect/openai', wires: [['responses', 'Responses'], ['chat_completions', 'Chat Completions']], defaultWire: 'responses'},
    gemini: {endpoint: '/api/detect/gemini', wires: [['chat_completions', 'Chat Completions'], ['generate_content', 'Gemini generateContent'], ['interactions', 'Gemini Interactions']], defaultWire: 'chat_completions'},
  };
  let submitting = false, completed = false, uncertain = false, active = true;
  let submitController = null, submitTimeout = null, probeController = null, probeTimeout = null, generation = 0, submitGeneration = 0;
  const locked = new Map();
  const secure = () => location.protocol === 'https:' || ['localhost', '127.0.0.1', '::1', '[::1]'].includes(location.hostname);
  const chosen = () => catalog.find(entry => entry.id === vendor.value);
  function specification() {
    const entry = chosen();
    if (!entry || !Object.hasOwn(specs, entry.route)) return null;
    if (entry.route === 'openai' && entry.id !== 'openai') {
      return {...specs.openai, wires: [['chat_completions', 'Chat Completions']], defaultWire: 'chat_completions'};
    }
    return specs[entry.route];
  }
  function showError(message, input) {
    errorBox.textContent = message;
    errorBox.hidden = false;
    (el(input?.id + '-trigger') || input)?.focus();
  }
  function clearError() {
    if (!uncertain) { errorBox.hidden = true; errorBox.textContent = ''; }
  }
  function lockFields(yes) {
    if (yes) form.querySelectorAll('input,select,button').forEach(input => {
      locked.set(input, input.disabled); input.disabled = true;
    });
    else { locked.forEach((disabled, input) => { input.disabled = disabled; }); locked.clear(); }
    form.setAttribute('aria-busy', String(yes));
  }
  function abortProbe() {
    generation += 1;
    probeController?.abort(); probeController = null;
    clearTimeout(probeTimeout); probeTimeout = null;
    load.textContent = '读取接口模型';
  }
  function modelChoices(choices, preserve = true) {
    const previous = preserve ? model.value : '';
    const placeholder = new Option('请选择目标模型', ''); placeholder.disabled = true;
    const values = new Set();
    const options = [];
    for (const item of choices.slice(0, 500)) {
      const value = typeof item === 'string' ? item : item.id;
      if (typeof value !== 'string' || !value || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value) || values.has(value)) continue;
      values.add(value);
      options.push(new Option(typeof item === 'string' ? value : item.label, value));
    }
    model.replaceChildren(placeholder, ...options);
    model.value = values.has(previous) ? previous : '';
    model.disabled = false;
    model.dispatchEvent(new Event('change', {bubbles: true}));
  }
  function updatePlan() {
    const spec = specification();
    const validWire = spec?.wires.find(([value]) => value === wire.value);
    el('quick-plan-label').textContent = `${modeLabels[mode.value] || '请选择检测深度'} · ${validWire?.[1] || '请选择接口'}`;
    const bounded = ['responses', 'interactions', 'generate_content'].includes(wire.value);
    el('quick-budget').textContent = bounded
      ? `本次最多 ${{quick: 2, standard: 3, full: 5}[mode.value]} 次模型请求，每次输出上限 4096 Token（含推理）；费用由你的 Key 承担。`
      : `${modeLabels[mode.value] || '检测'}，不额外发送付费预检；不启用长上下文。请求会消耗你的上游 API 额度。`;
    start.disabled = !secure() || !spec || submitting || completed || uncertain;
    load.disabled = !secure() || !spec || submitting || completed || uncertain || !!probeController
      || (chosen()?.route === 'gemini' && wire.value !== 'chat_completions');
    if (spec) form.action = spec.endpoint;
  }
  function updateVendor() {
    abortProbe();
    const entry = chosen(), spec = specification();
    modelChoices(entry?.models || [], false);
    wire.replaceChildren(...(spec?.wires || []).map(([value, label]) => new Option(label, value)));
    wire.value = spec?.defaultWire || '';
    hint.textContent = entry?.id === 'other'
      ? '填好地址和 Key 后，点“读取接口模型”选择实际型号。'
      : '选择要测的模型；也可读取接口声明的模型列表。';
    clearError(); updatePlan();
  }
  function credentials() {
    if (!secure()) { showError('请通过 HTTPS 正式入口填写 API Key。'); return null; }
    const url = base.value.trim(), apiKey = key.value.trim();
    let parsed;
    try { parsed = new URL(url); } catch { /* reported below */ }
    if (!parsed || !['https:', 'http:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password
      || url.length > 2048 || /[\u0000-\u0020\u007f?#]/.test(url)) {
      showError('请填写不含账号、密码、查询参数或 # 片段的 HTTP(S) Base URL。', base); return null;
    }
    if (apiKey.length < 8 || apiKey.length > 4096 || /[\u0000-\u001f\u007f]/.test(apiKey)) {
      showError('请填写有效的 API Key（8–4096 个字符）。', key); return null;
    }
    return {url, apiKey};
  }
  vendor.addEventListener('change', updateVendor);
  mode.addEventListener('change', () => { clearError(); updatePlan(); });
  wire.addEventListener('change', () => {
    abortProbe(); modelChoices(chosen()?.models || []); clearError(); updatePlan();
    hint.textContent = chosen()?.route === 'gemini' && wire.value !== 'chat_completions'
      ? '原生接口从候选目录选择；不会自动读取兼容模型列表或切换接口。'
      : '选择要测的模型；也可读取接口声明的模型列表。';
  });
  model.addEventListener('change', clearError);
  [base, key].forEach(input => input.addEventListener('input', () => {
    abortProbe(); modelChoices(chosen()?.models || []); clearError(); updatePlan();
  }));
  load.addEventListener('click', async () => {
    if (load.disabled || submitting || uncertain) return;
    const values = credentials();
    if (!values) return;
    abortProbe();
    const token = generation;
    const controller = new AbortController(); probeController = controller;
    probeTimeout = setTimeout(() => controller.abort(), 20000);
    const data = new FormData(); data.set('base_url', values.url); data.set('api_key', values.apiKey);
    clearError(); updatePlan(); load.textContent = '正在读取模型…';
    try {
      const response = await fetch('/api/probe', {method: 'POST', body: data, credentials: 'same-origin', cache: 'no-store', signal: controller.signal});
      const result = await response.json();
      if (!active || token !== generation || submitting) return;
      if (!response.ok || !result.ok) throw new Error('模型列表暂时读取失败，请检查地址、Key 或稍后再试；也可使用候选模型直接检测。');
      if (!result.models_endpoint_supported) {
        hint.textContent = '接口没有提供模型列表；仍可选用候选型号直接检测。'; return;
      }
      const groups = wire.value === 'responses' ? (result.by_responses_vendor || result.by_vendor) : result.by_vendor;
      const models = groups ? (groups[vendor.value] || []) : (result.by_protocol?.[{claude: 'anthropic', openai: 'openai', gemini: 'gemini'}[chosen()?.route]] || []);
      modelChoices(Array.isArray(models) ? models : []);
      hint.textContent = model.options.length > 1
        ? '模型来自接口声明；可用性与能力由接下来的实际检测确认。'
        : '接口未列出当前厂商的型号，请检查厂商选择或使用候选目录。';
    } catch (error) {
      if (active && token === generation && !submitting) showError(error.name === 'AbortError'
        ? '读取模型列表超时，不会自动重试。你仍可使用候选模型开始检测。'
        : '模型列表读取失败，请检查地址、Key 或稍后再试；也可使用候选模型直接检测。');
    } finally {
      data.delete('api_key');
      if (token === generation) { clearTimeout(probeTimeout); probeController = null; probeTimeout = null; load.textContent = '读取接口模型'; updatePlan(); }
    }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!active || submitting || completed || uncertain) return;
    const values = credentials(), spec = specification();
    if (!values) return;
    if (!spec || !model.value || model.value.length > 200 || /[\u0000-\u001f\u007f]/.test(model.value)) {
      showError('请先选择目标模型。', model); return;
    }
    if (!Object.hasOwn(modeLabels, mode.value) || !spec.wires.some(([value]) => value === wire.value)) {
      showError('请检查检测深度和请求接口。'); return;
    }
    abortProbe(); clearError(); submitting = true;
    const token = ++submitGeneration;
    const data = new FormData();
    data.set('base_url', values.url); data.set('api_key', values.apiKey);
    data.set('model', model.value); data.set('mode', mode.value); data.set('wire_api', wire.value);
    // The first real probe in the job checks availability. Avoid an extra
    // paid ping / model-confirmation step before opening the progress page.
    data.set('force', 'true');
    data.set('include_long_context', 'false'); data.set('include_long_context_extreme', 'false');
    lockFields(true); start.textContent = '正在创建检测…';
    const controller = new AbortController(); submitController = controller;
    const timeout = setTimeout(() => controller.abort(), 30000); submitTimeout = timeout;
    let rejected = false;
    try {
      const response = await fetch(spec.endpoint, {method: 'POST', body: data, credentials: 'same-origin', cache: 'no-store', signal: controller.signal});
      if (!active || token !== submitGeneration) return;
      if (!response.ok) {
        rejected = response.status >= 400 && response.status < 500;
        const body = await response.json().catch(() => ({}));
        if (!active || token !== submitGeneration) return;
        const reason = typeof body.detail === 'string' ? body.detail : '未能创建检测，请检查填写内容后重试。';
        throw new Error(reason.replaceAll(values.apiKey, '[已隐藏]'));
      }
      const result = await response.json();
      if (!active || token !== submitGeneration) return;
      if (typeof result.job_id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(result.job_id)) throw new Error('Invalid job response');
      completed = true; key.value = '';
      if (active && token === submitGeneration) location.assign('/r/' + result.job_id);
    } catch (error) {
      if (!active || token !== submitGeneration) return;
      uncertain = !rejected;
      showError(rejected ? error.message : '提交结果暂未确认，服务器可能已接收任务。请勿连续重复提交，以免产生额外费用；本页不会自动重试。');
    } finally {
      data.delete('api_key'); clearTimeout(timeout);
      if (token !== submitGeneration) return;
      submitTimeout = null; submitController = null;
      submitting = false;
      if (!completed) lockFields(false);
      start.textContent = uncertain ? '提交状态待确认' : completed ? '正在打开检测结果…' : '开始检测';
      updatePlan();
    }
  });
  window.addEventListener('pagehide', () => {
    active = false; submitGeneration += 1; abortProbe(); submitController?.abort(); clearTimeout(submitTimeout); key.value = '';
  });
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    active = true; completed = false; submitting = false; uncertain = false; key.value = '';
    lockFields(false); start.textContent = '开始检测'; clearError(); updatePlan();
  });
  updateVendor();
})();
