// Responses has a separate, bounded probe plan. Changing this UI never sends
// a model request; the form submit is the sole inference action.
(function () {
  const wire = document.getElementById('wire-api');
  const mode = document.getElementById('mode');
  const vendor = document.getElementById('model-vendor');
  if (!wire || !mode) return;
  const budget = document.getElementById('responses-budget');
  const advanced = document.getElementById('chat-advanced-options');
  const plans = {
    quick: '最多 2 次请求：基础回复与流式完整性',
    standard: '最多 3 次请求：基础回复、流式完整性、结构化输出',
    full: '最多 5 次请求：基础回复、流式完整性、结构化输出、工具调用往返',
  };
  function update() {
    const responses = wire.value === 'responses';
    budget.hidden = !responses;
    advanced.hidden = responses;
    advanced.querySelectorAll('input[type="checkbox"]').forEach(input => {
      input.disabled = responses;
      if (responses) input.checked = false;
    });
    budget.textContent = `Responses ${plans[mode.value]}。每次输出上限 4,096 Token（含推理），不自动重试；由你的 Key 支付，实际费用取决于模型和服务商价格。`;
    const labels = responses
      ? ['快速 · 基础与流式', '标准 · 加测结构化输出', '完整 · 加测工具往返']
      : ['快速 · 基础请求', '标准 · 协议与流式检查', '完整 · 全部适用项目'];
    Array.from(mode.options).forEach((option, index) => { option.textContent = labels[index]; });
    if (responses) {
      const scope = document.getElementById('vendor-scope');
      if (scope) scope.textContent = '检测 Responses 接口的实际能力；候选型号不代表该入口已开放权限，未完成的能力不作通过结论。';
    }
  }
  wire.addEventListener('change', update);
  mode.addEventListener('change', update);
  vendor?.addEventListener('change', () => {
    wire.value = vendor.value === 'openai' ? 'responses' : 'chat_completions';
    wire.dispatchEvent(new Event('change', {bubbles:true}));
    queueMicrotask(update);
  });
  update();
})();

(function () {
  const wire = document.getElementById('gemini-wire-api');
  if (!wire) return;
  const mode = document.getElementById('mode');
  const budget = document.getElementById('gemini-native-budget');
  const base = document.getElementById('base_url');
  const update = () => {
    const native = wire.value !== 'chat_completions';
    budget.hidden = !native;
    budget.textContent = `本次最多 ${ {quick: 2, standard: 3, full: 5}[mode.value] } 次请求，每次输出上限 4096 tokens。无额外付费预检、自动重试或接口切换；用量由你的 Key 承担，实际费用以服务商为准。`;
    base.placeholder = native ? 'https://generativelanguage.googleapis.com/v1beta' : 'https://generativelanguage.googleapis.com/v1beta/openai';
    const labels = native ? ['快速 · 基础与流式', '标准 · 加测结构化输出', '完整 · 加测工具往返'] : ['快速 · 基础请求', '标准 · 协议与流式检查', '完整 · 全部适用项目'];
    Array.from(mode.options).forEach((option, index) => { option.textContent = labels[index]; });
    document.getElementById('gemini-interface-hint').textContent = native
      ? '原生接口不自动探测兼容模型列表。候选目录不代表本站已开通；地址保留服务商指定的版本前缀，只有根域名时追加 /v1beta。'
      : '选择与中转站实际文档一致的接口；不会自动切换。';
    if (native) document.getElementById('model-choice-hint').textContent = '从官方候选目录选择；原生接口不自动读取兼容模型列表。此型号是否可用，以首次检测请求为准。';
    const intro = document.querySelector('.detect-aside li:first-child p');
    if (intro) intro.textContent = native ? '填写服务商提供的原生接口地址和 Key，确认所选接口已开放。' : '填写服务商提供的地址和 Key，读取可用模型列表。';
  };
  wire.addEventListener('change', () => queueMicrotask(update));
  [base, document.getElementById('api_key')].forEach(input => input.addEventListener('input', () => queueMicrotask(update)));
  mode.addEventListener('change', update);
  update();
})();

// Mobile navigation closes on outside clicks, links and Escape.
(function () {
  const toggle = document.querySelector('.nav-toggle');
  const nav = document.getElementById('site-nav');
  if (!toggle || !nav) return;

  function setOpen(open) {
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-label', open ? '关闭菜单' : '打开菜单');
  }

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = toggle.getAttribute('aria-expanded') === 'true';
    setOpen(!isOpen);
  });

  // Close on tap outside the dropdown.
  document.addEventListener('click', (e) => {
    if (toggle.getAttribute('aria-expanded') !== 'true') return;
    if (nav.contains(e.target) || toggle.contains(e.target)) return;
    setOpen(false);
  });

  // Close after a nav link is tapped — otherwise the panel stays open over
  // the new page transition (jarring on mobile).
  nav.addEventListener('click', (e) => {
    if (e.target.tagName === 'A') setOpen(false);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
      setOpen(false);
      toggle.focus();
    }
  });
  window.matchMedia('(min-width: 761px)').addEventListener('change', () => setOpen(false));
})();


// Refuse to collect API keys on a public plain-HTTP page. The server repeats
// this check before form parsing; this browser guard prevents the secret from
// leaving the user's device in the first place.
(function () {
  if (location.protocol === 'https:') return;
  const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
  if (localHosts.has(location.hostname)) return;

  const form = document.getElementById('detect-form');
  const apiKeyInput = document.getElementById('api_key');
  if (!form || !apiKeyInput) return;

  apiKeyInput.disabled = true;
  const submit = document.getElementById('submit-btn');
  if (submit) {
    submit.disabled = true;
    submit.title = '请使用 HTTPS 正式入口';
  }

  const warning = document.createElement('div');
  warning.className = 'transport-warning';
  warning.setAttribute('role', 'alert');
  warning.textContent = '当前是 HTTP 预发布入口。为保护 API key，检测功能已锁定；HTTPS 上线后自动开放。';
  form.prepend(warning);
})();


// Native selects work with touch and keyboard without opening a text keyboard.
(function () {
  const input = document.getElementById('model');
  if (!input || input.tagName !== 'SELECT') return;
  let defaults = Array.from(input.options).filter(option => option.value).map(option => ({value: option.value, label: option.textContent}));
  const vendor = document.getElementById('model-vendor');
  if (vendor) vendor.addEventListener('change', () => {
    const catalog = JSON.parse(vendor.dataset.catalog || '[]');
    const entry = catalog.find(v => v.id === vendor.value);
    defaults = (entry?.models || []).map(m => ({value: m.id, label: m.label}));
    input.value = '';
    window.gewuResetModelChoices();
    const scope = document.getElementById('vendor-scope');
    if (scope) scope.textContent = vendor.value === 'openai'
      ? '按官方能力运行检测；模型不支持的项目会跳过，不扣分。'
      : '基础兼容检测：快速模式检查基础请求，标准模式增加流式一致性。不验证模型身份、工具能力或计费；不能与完整 GPT 分数直接比较。';
    const extras = document.querySelector('.detect-extra');
    if (extras) {
      extras.hidden = vendor.value !== 'openai';
      if (extras.hidden) extras.querySelectorAll('input[type="checkbox"]').forEach(box => { box.checked = false; });
    }
  });
  if (vendor && vendor.value !== 'openai') {
    const extras = document.querySelector('.detect-extra');
    if (extras) extras.hidden = true;
  }
  window.gewuResetModelChoices = function () {
    const previous = input.value;
    const placeholder = new Option('请选择目标模型', '');
    placeholder.disabled = true;
    input.replaceChildren(placeholder, ...defaults.map(option => new Option(option.label, option.value)));
    if (previous && !defaults.some(option => option.value === previous)) {
      input.add(new Option(`${previous}（待接口确认）`, previous));
    }
    input.value = previous;
    const hint = document.getElementById('model-choice-hint');
    const geminiWire = document.getElementById('gemini-wire-api')?.value;
    if (hint) hint.textContent = geminiWire && geminiWire !== 'chat_completions'
      ? '从官方候选目录选择；原生接口不自动读取兼容模型列表。此型号是否可用，以首次检测请求为准。'
      : '地址或 Key 已更新；当前候选待接口确认，离开输入框后重新读取模型列表。';
  };
  window.gewuSetModelChoices = function (values) {
    const previous = input.value;
    const choices = [...new Set(values.filter(v => typeof v === 'string' && v.trim() && v.length <= 200))];
    const placeholder = new Option('请选择目标模型', '');
    placeholder.disabled = true;
    input.replaceChildren(placeholder, ...choices.map(v => new Option(v, v)));
    input.value = choices.includes(previous) ? previous : '';
    const hint = document.getElementById('model-choice-hint');
    if (hint) hint.textContent = previous && !choices.includes(previous)
      ? '接口未列出刚才选中的模型，请从列表重新选择；不会自动替换模型。'
      : '列表来自当前接口声明；是否真正可调用，会在提交检测时确认。';
  };
})();


// Pre-submission probe: hit /api/probe on api_key blur, render an inline
// pill below the api_key input describing what the relay carries, replace
// the model dropdown with the actually-available models, and (when the
// current protocol has 0 matches) offer one-click handoff to a protocol
// the relay DOES carry.
(function () {
  const protocol =
    location.pathname.startsWith('/claude') ? 'anthropic' :
    location.pathname.startsWith('/openai') ? 'openai' :
    location.pathname.startsWith('/gemini') ? 'gemini' : null;
  if (!protocol) return;

  const protoLabel = {anthropic: 'Claude', openai: 'OpenAI', gemini: 'Gemini'}[protocol];
  const protoPath = {anthropic: '/claude', openai: '/openai', gemini: '/gemini'};

  const baseUrlInput = document.getElementById('base_url');
  const apiKeyInput = document.getElementById('api_key');
  if (!baseUrlInput || !apiKeyInput) return;

  // Inject pill container right after the api_key field's hint.
  const apiKeyField = apiKeyInput.closest('.field');
  const pill = document.createElement('div');
  pill.id = 'probe-pill';
  pill.className = 'probe-pill';
  pill.hidden = true;
  pill.setAttribute('role', 'status');
  pill.setAttribute('aria-live', 'polite');
  apiKeyField.appendChild(pill);

  let inflight = null;
  let lastKey = null;

  async function runProbe() {
    if (document.getElementById('gemini-wire-api')?.value && document.getElementById('gemini-wire-api').value !== 'chat_completions') return;
    const baseUrl = baseUrlInput.value.trim();
    const apiKey = apiKeyInput.value.trim();
    if (!baseUrl || !apiKey || apiKey.length < 8) return;
    if (!/^https?:\/\//.test(baseUrl)) return;

    const key = JSON.stringify([baseUrl, apiKey, document.getElementById('model-vendor')?.value]);
    if (key === lastKey) return; // already probed this combo
    lastKey = key;

    setPill('neutral', '🔄 正在识别中转站可用模型...');
    if (inflight) inflight.abort && inflight.abort();
    const ctrl = new AbortController();
    const probeTimeout = setTimeout(() => ctrl.abort(), 20000);
    inflight = ctrl;

    const fd = new FormData();
    fd.set('base_url', baseUrl);
    fd.set('api_key', apiKey);
    let r, data;
    try {
      r = await fetch('/api/probe', {method: 'POST', body: fd, signal: ctrl.signal});
      data = await r.json();
    } catch (e) {
      if (inflight !== ctrl) return;
      lastKey = null;
      if (e.name === 'AbortError') {
        setPill('warn', '⚪ 模型列表探测超时,不影响继续检测');
        return;
      }
      setPill('warn', '⚪ 探测失败,但不影响检测继续 — 将尝试你选中的模型');
      return;
    } finally {
      clearTimeout(probeTimeout);
    }
    if (inflight !== ctrl) return;
    if (r.status === 429) {
      // Rate limited — surface clearly and keep submit enabled so the user
      // can still proceed (they're not blocked from detection itself).
      setPill('warn', '⚠ ' + (data.error || '探测过于频繁,稍后再试') + '(检测仍可正常提交)');
      lastKey = null; // allow retry after backoff
      return;
    }
    renderProbeResult(data);
  }

  function renderProbeResult(data) {
    lastProbeData = data;
    if (!data.ok) {
      // Auth fail vs other errors — auth_ok=false is the only blocking case
      if (data.auth_ok === false) {
        setPill('fail', '🔴 ' + (data.error || '鉴权失败'));
      } else {
        setPill('warn', '⚪ ' + (data.error || '探测失败') + ' — 不影响检测继续');
      }
      return;
    }

    if (!data.models_endpoint_supported) {
      setPill('neutral', '⚪ ' + (data.note || '该中转站不暴露 /v1/models') + '(检测可正常进行)');
      return;
    }

    const selectedVendor = document.getElementById('model-vendor')?.value;
    const vendorModels = document.getElementById('wire-api')?.value === 'responses'
      ? (data.by_responses_vendor || data.by_vendor) : data.by_vendor;
    const myModels = selectedVendor && vendorModels
      ? (vendorModels[selectedVendor] || [])
      : ((data.by_protocol && data.by_protocol[protocol]) || []);
    const total = data.raw_count || 0;

    if (myModels.length === 0) {
      if (window.gewuSetModelChoices) window.gewuSetModelChoices([]);
      // The headline case: cross-protocol suggestion.
      const others = Object.keys(data.by_protocol || {})
        .filter((p) => p !== protocol && data.by_protocol[p].length > 0)
        .map((p) => ({proto: p, count: data.by_protocol[p].length, sample: data.by_protocol[p][0]}));

      let html =
        '<div class="probe-headline">🟡 接口未列出当前厂商的文本模型</div>' +
        '<div class="probe-detail">已读取 ' + total + ' 个模型。可切换厂商查看其他候选。</div>';
      if (others.length) {
        html += '<div class="probe-actions">';
        others.forEach((o) => {
          const label = {anthropic: 'Claude', openai: 'OpenAI', gemini: 'Gemini'}[o.proto];
          html +=
            '<button type="button" class="btn btn-ghost probe-action" data-handoff="' + o.proto + '">' +
            '改用 ' + label + ' 协议 (' + o.count + ' 个候选)</button>';
        });
        html += '</div>';
      }
      setPillHtml('warn', html);
      bindHandoff();
      // Disable submit — running detection here will produce 0% report.
      setSubmitEnabled(false, '该中转站没有 ' + protoLabel + ' 模型');
      return;
    }

    // Happy path: at least one model matches our protocol.
    const sample = myModels.slice(0, 4).join(', ');
    const more = myModels.length > 4 ? ` 等共 ${myModels.length} 个` : '';
    setPillHtml(
      'ok',
      '<div class="probe-headline">🟢 接口声明 ' + total + ' 个模型,本页筛选出 ' + myModels.length + ' 个候选</div>' +
      '<div class="probe-detail">' + escapeHtml(sample) + escapeHtml(more) + '</div>' +
      '<div class="probe-detail">是否真正可调用,会在提交时通过真实请求确认。</div>'
    );

    // Replace the dropdown with what the relay actually carries.
    if (window.gewuSetModelChoices) {
      window.gewuSetModelChoices(myModels);
    }
    setSubmitEnabled(true);

    // Stash best_by_protocol globally — the submit handler reads it when
    // preflight 422s so it can offer a one-click swap to the recommended
    // model.
    window.gewuBestByProtocol = data.best_by_protocol || {};

    // Keep a valid selection; otherwise require an explicit new choice.
  }

  function setPill(level, text) {
    pill.className = 'probe-pill probe-' + level;
    pill.textContent = text;
    pill.hidden = false;
  }

  let lastProbeData = null;
  document.getElementById('gemini-wire-api')?.addEventListener('change', () => {
    if (inflight) inflight.abort();
    inflight = null;
    lastKey = null;
    lastProbeData = null;
    pill.hidden = true;
    setSubmitEnabled(true);
    window.gewuBestByProtocol = {};
    if (window.gewuResetModelChoices) window.gewuResetModelChoices();
  });
  document.getElementById('wire-api')?.addEventListener('change', () => {
    if (lastProbeData) renderProbeResult(lastProbeData);
  });
  document.getElementById('model-vendor')?.addEventListener('change', () => {
    if (inflight) inflight.abort();
    inflight = null;
    lastKey = null;
    pill.hidden = true;
    setSubmitEnabled(true);
    runProbe();
  });
  function setPillHtml(level, html) {
    pill.className = 'probe-pill probe-' + level;
    pill.innerHTML = html;
    pill.hidden = false;
  }

  function setSubmitEnabled(ok, reason) {
    const btn = document.getElementById('submit-btn');
    if (!btn) return;
    btn.disabled = !ok;
    btn.title = ok ? '' : (reason || '');
  }

  function bindHandoff() {
    pill.querySelectorAll('[data-handoff]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-handoff');
        try {
          sessionStorage.setItem('gewu:handoff', JSON.stringify({
            base_url: baseUrlInput.value.trim(),
            from: protocol,
          }));
        } catch (_) { /* sessionStorage unavailable — page navigates anyway */ }
        location.href = protoPath[target];
      });
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Trigger probe on api_key blur. Also re-probe when base_url changes
  // (after blur) so users editing both fields don't miss a re-check.
  apiKeyInput.addEventListener('blur', runProbe);
  [apiKeyInput, baseUrlInput].forEach(input => input.addEventListener('input', () => {
    const pending = inflight;
    inflight = null;
    if (pending) pending.abort();
    lastKey = null;
    lastProbeData = null;
    window.gewuBestByProtocol = {};
    if (window.gewuResetModelChoices) window.gewuResetModelChoices();
    pill.hidden = true;
    setSubmitEnabled(true);
  }));
  baseUrlInput.addEventListener('blur', () => {
    lastKey = null; // base changed → invalidate dedup
    runProbe();
  });

  // Cross-protocol handoff: carry only the relay URL. API keys never enter
  // browser storage; the user deliberately re-enters the key on the target
  // page. Single-shot — clear the URL handoff after reading it.
  try {
    const raw = sessionStorage.getItem('gewu:handoff');
    if (raw) {
      sessionStorage.removeItem('gewu:handoff');
      const data = JSON.parse(raw);
      if (data && data.base_url) {
        baseUrlInput.value = data.base_url;
        const fromLabel = {anthropic: 'Claude', openai: 'OpenAI', gemini: 'Gemini'}[data.from] || data.from;
        setPill('neutral', '已从 ' + fromLabel + ' 页面带入中转站地址。为保护密钥，请重新粘贴 API 密钥。');
        apiKeyInput.focus();
      }
    }
  } catch (_) { /* malformed handoff — ignore */ }
})();


(function () {
  const form = document.getElementById('detect-form');
  if (!form) return;
  const submitBtn = document.getElementById('submit-btn');
  const errBox = document.getElementById('form-error');

  function endpointFor() {
    return form.getAttribute('data-endpoint')
      || (location.pathname.startsWith('/claude')
        ? '/api/detect/claude'
        : location.pathname.startsWith('/openai')
        ? '/api/detect/openai'
        : location.pathname.startsWith('/gemini')
        ? '/api/detect/gemini'
        : '/api/detect');
  }

  function currentProtocol() {
    return location.pathname.startsWith('/claude') ? 'anthropic' :
           location.pathname.startsWith('/openai') ? 'openai' :
           location.pathname.startsWith('/gemini') ? 'gemini' : null;
  }

  function renderModelDeadError(detail) {
    const proto = currentProtocol();
    const recommended = (window.gewuBestByProtocol || {})[proto];
    const model = detail.model || '该模型';
    const reason = detail.upstream_error || '上游拒绝';

    errBox.innerHTML = '';
    errBox.hidden = false;
    errBox.classList.add('form-warning-rich');

    const title = document.createElement('div');
    title.className = 'form-error-title';
    title.textContent = '单次预检未通过,尚未生成检测分数';
    errBox.appendChild(title);

    const explanation = document.createElement('div');
    explanation.className = 'form-error-explanation';
    explanation.textContent = '预检只发送一条最小请求,不能替代完整检测。你可以继续运行全部检测并生成可复核分数。';
    errBox.appendChild(explanation);

    const details = document.createElement('details');
    details.className = 'form-error-details';
    const summary = document.createElement('summary');
    summary.textContent = '查看预检返回';
    const body = document.createElement('div');
    body.className = 'form-error-body';
    body.textContent = `${model}: ${reason}`;
    details.appendChild(summary);
    details.appendChild(body);
    errBox.appendChild(details);

    const actions = document.createElement('div');
    actions.className = 'form-error-actions';

    const continueBtn = document.createElement('button');
    continueBtn.type = 'button';
    continueBtn.className = 'btn btn-primary';
    continueBtn.textContent = '继续完整检测并生成分数';
    continueBtn.title = '跳过单次预检,由完整检测流程给出最终分数和证据。';
    continueBtn.addEventListener('click', () => {
      let force = form.querySelector('input[name="force"]');
      if (!force) {
        force = document.createElement('input');
        force.type = 'hidden';
        force.name = 'force';
        form.appendChild(force);
      }
      force.value = '1';
      errBox.hidden = true;
      errBox.classList.remove('form-warning-rich');
      form.requestSubmit();
    });
    actions.appendChild(continueBtn);

    if (recommended && recommended !== model) {
      const swapBtn = document.createElement('button');
      swapBtn.type = 'button';
      swapBtn.className = 'btn btn-ghost';
      swapBtn.textContent = `改用 ${recommended}`;
      swapBtn.addEventListener('click', () => {
        const modelInput = document.getElementById('model');
        if (modelInput) {
          if (!Array.from(modelInput.options).some(option => option.value === recommended)) {
            modelInput.add(new Option(recommended, recommended));
          }
          modelInput.value = recommended;
        }
        errBox.hidden = true;
        errBox.classList.remove('form-warning-rich');
        const force = form.querySelector('input[name="force"]');
        if (force) force.value = '';
        form.requestSubmit();
      });
      actions.appendChild(swapBtn);
    }

    errBox.appendChild(actions);
  }

  function clearStaleFeedback() {
    if (errBox.hidden) return;
    errBox.hidden = true;
    errBox.textContent = '';
    errBox.classList.remove('form-error-rich', 'form-warning-rich');
    const force = form.querySelector('input[name="force"]');
    if (force) force.value = '';
  }

  form.querySelectorAll('input, select').forEach((field) => {
    field.addEventListener('input', clearStaleFeedback);
    field.addEventListener('change', clearStaleFeedback);
  });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    errBox.hidden = true;
    errBox.classList.remove('form-error-rich', 'form-warning-rich');
    submitBtn.disabled = true;
    submitBtn.textContent = document.getElementById('wire-api')?.value === 'responses'
      ? '正在提交检测…' : '正在确认模型可用…';

    const fd = new FormData(form);
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 30000);
      let r;
      try {
        r = await fetch(endpointFor(), {method: 'POST', body: fd, signal: ctrl.signal});
      } finally {
        clearTimeout(timeout);
      }
      if (r.status === 422) {
        const j = await r.json().catch(() => ({}));
        const detail = j && j.detail;
        if (detail && detail.code === 'model_not_alive') {
          renderModelDeadError(detail);
          submitBtn.disabled = false;
          submitBtn.textContent = '开始检测';
          return;
        }
      }
      if (!r.ok) {
        const j = await r.json().catch(() => ({detail: 'request failed'}));
        const msg = typeof j.detail === 'string' ? j.detail
          : (j.detail && j.detail.message) || ('HTTP ' + r.status);
        throw new Error(msg);
      }
      const j = await r.json();
      form.api_key.value = '';
      // Clear force flag so a subsequent submission goes through preflight.
      const force = form.querySelector('input[name="force"]');
      if (force) force.value = '';
      location.href = '/r/' + j.job_id;
    } catch (e) {
      errBox.hidden = false;
      errBox.textContent = e.name === 'AbortError'
        ? '提交确认超时,请检查网络后重试。API 密钥未被保存。'
        : (e.message || '提交失败');
      submitBtn.disabled = false;
      submitBtn.textContent = '开始检测';
    }
  });
})();

// FAQ dual-mode toggle (通俗 / 开发者).
// Two <p data-mode="layperson|developer"> per question are both in DOM
// (so search engines index both); CSS hides whichever doesn't match the
// section's data-mode. Choice persists in localStorage so the user
// doesn't have to re-toggle every visit.
(() => {
  const STORAGE_KEY = 'gewu_faq_mode';
  const sections = document.querySelectorAll('.faq[data-mode]');
  if (!sections.length) return;

  // Restore saved preference (if any) before any clicks.
  const saved = (() => {
    try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
  })();
  if (saved === 'layperson' || saved === 'developer') {
    sections.forEach((sec) => {
      sec.dataset.mode = saved;
      sec.querySelectorAll('.faq-mode-btn').forEach((b) => {
        const active = b.dataset.mode === saved;
        b.classList.toggle('faq-mode-active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });
    });
  }

  // Click handler: switch mode + persist.
  sections.forEach((sec) => {
    sec.querySelectorAll('.faq-mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        if (!mode) return;
        sec.dataset.mode = mode;
        sec.querySelectorAll('.faq-mode-btn').forEach((b) => {
          const active = b === btn;
          b.classList.toggle('faq-mode-active', active);
          b.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* ignore */ }
      });
    });
  });
})();

// Homepage history lookup. The first action is read-only: exact known domains
// open their internal evidence page; partial queries continue in the full list.
(() => {
  const form = document.getElementById('history-search-form');
  const input = document.getElementById('home-domain-search');
  if (!form || !input) return;

  const rows = Array.from(document.querySelectorAll('[data-home-rank-row]'));
  const empty = document.getElementById('home-ranking-empty');
  const status = document.getElementById('history-search-status');
  const knownDomains = new Set(
    Array.from(document.querySelectorAll('#home-domain-options option'))
      .map((option) => String(option.value || '').trim().toLowerCase())
      .filter(Boolean),
  );
  const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9.-]{1,251}[a-z0-9])$/;

  function normalizeLookup(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return '';
    try {
      const candidate = raw.includes('://') ? new URL(raw) : new URL(`https://${raw}`);
      return candidate.hostname.replace(/\.$/, '');
    } catch {
      return raw.replace(/\.$/, '');
    }
  }

  function filterPreview() {
    const query = normalizeLookup(input.value);
    let visible = 0;
    rows.forEach((row) => {
      const show = !query || String(row.dataset.domain || '').includes(query);
      row.hidden = !show;
      if (show) visible += 1;
    });
    const exactMatch = knownDomains.has(query);
    if (empty) {
      empty.hidden = visible !== 0 || !query;
      if (!empty.hidden) {
        empty.textContent = exactMatch
          ? '该域名不在首页前列，但完整榜单中有记录；按回车查看站内报告。'
          : '首页前列暂无匹配；按回车搜索完整榜单。';
      }
    }
    if (!status) return;
    if (!query) status.textContent = '';
    else if (exactMatch) status.textContent = `已找到 ${query}，按回车查看站内报告。`;
    else if (visible) status.textContent = `首页前列有 ${visible} 个匹配项；按回车搜索完整榜单。`;
    else status.textContent = '首页前列暂无匹配；按回车搜索完整榜单。';
  }

  input.addEventListener('input', filterPreview);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const query = normalizeLookup(input.value);
    if (!query) {
      input.focus();
      if (status) status.textContent = '请输入中转站域名或 URL。';
      return;
    }
    if (knownDomains.has(query) && DOMAIN_RE.test(query)) {
      location.href = `/leaderboard/${encodeURIComponent(query)}`;
      return;
    }
    location.href = `/leaderboard?query=${encodeURIComponent(query)}#ranking-browser`;
  });
})();

// Homepage quick launcher and safe Base URL handoff. API keys never enter URLs.
(() => {
  function parseSafeBaseUrl(value) {
    let parsed;
    try { parsed = new URL(value); } catch { return null; }
    if (!['http:', 'https:'].includes(parsed.protocol)
      || !parsed.hostname
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash) {
      return null;
    }
    return parsed;
  }

  const launcher = document.getElementById('quick-check');
  if (launcher) {
    const input = document.getElementById('quick-base-url');
    const modelInput = document.getElementById('quick-model');
    const error = document.getElementById('quick-check-error');
    const vendorInput = document.getElementById('quick-vendor');
    const catalog = JSON.parse(vendorInput?.dataset.catalog || '[]');
    vendorInput?.addEventListener('change', () => {
        const vendor = catalog.find(v => v.id === vendorInput.value);
        const placeholder = new Option('请选择目标模型', '');
        placeholder.disabled = true;
        placeholder.selected = true;
        modelInput.replaceChildren(placeholder, ...(vendor?.models || []).map(m => new Option(m.label, m.id)));
        modelInput.disabled = vendor?.id === 'other';
        const hint = document.getElementById('quick-model-hint');
        if (hint) hint.textContent = vendor?.id === 'other'
          ? '下一步填写地址和 Key，读取接口模型列表后选择。'
          : '从官方候选中选择；下一步按接口声明确认可用性。';
        if (error) error.hidden = true;
    });
    launcher.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!modelInput?.value && vendorInput?.value !== 'other') {
        if (error) { error.textContent = '请先从列表中选择目标模型'; error.hidden = false; }
        modelInput?.focus();
        return;
      }
      const value = String(input?.value || '').trim();
      const parsed = parseSafeBaseUrl(value);
      if (!parsed) {
        if (error) {
          error.textContent = '\u8bf7\u8f93\u5165\u4e0d\u542b\u8d26\u53f7\u3001\u5bc6\u7801\u3001\u67e5\u8be2\u53c2\u6570\u6216 # \u7247\u6bb5\u7684 HTTP(S) Base URL';
          error.hidden = false;
        }
        input?.focus();
        return;
      }
      const vendor = catalog.find(v => v.id === vendorInput?.value);
      const protocol = vendor?.route || 'claude';
      const target = new URL(`/${protocol}`, location.origin);
      target.searchParams.set('vendor', vendor?.id || 'anthropic');
      target.searchParams.set('base_url', value);
      const model = String(modelInput?.value || '').trim();
      if (model && model.length <= 120 && !/[\u0000-\u001f\u007f]/.test(model)) {
        target.searchParams.set('model', model);
      }
      location.href = `${target.pathname}${target.search}#detect-form`;
    });
  }

  const detectorForm = document.getElementById('detect-form');
  const baseUrlInput = document.getElementById('base_url');
  const detectorModelInput = document.getElementById('model');
  if (detectorForm) {
    const params = new URLSearchParams(location.search);
    if (baseUrlInput && !baseUrlInput.value) {
      const candidate = params.get('base_url');
      if (candidate) {
        const parsed = parseSafeBaseUrl(candidate);
        if (parsed) baseUrlInput.value = candidate;
      }
    }
    if (detectorModelInput) {
      const candidateModel = String(params.get('model') || '').trim();
      if (
        candidateModel
        && candidateModel.length <= 120
        && !/[\u0000-\u001f\u007f]/.test(candidateModel)
      ) {
        if (detectorModelInput.tagName === 'SELECT'
          && !Array.from(detectorModelInput.options).some(option => option.value === candidateModel)) {
          detectorModelInput.add(new Option(`${candidateModel}（带入，待接口确认）`, candidateModel));
        }
        detectorModelInput.value = candidateModel;
      }
    }
  }
})();

// Client-side leaderboard search and dual filter. All rows remain in the HTML
// for accessibility and search indexing; filtering only changes presentation.
(() => {
  const search = document.getElementById('observation-search');
  const model = document.getElementById('observation-model');
  if (!search || !model) return;
  const rows = Array.from(document.querySelectorAll('[data-observation-row]'));
  search.value = (new URLSearchParams(location.search).get('query') || '').slice(0, 120);
  function apply() {
    let count = 0;
    const query = search.value.trim().toLowerCase();
    rows.forEach((row) => {
      row.hidden = !(row.dataset.search.includes(query)
        && (!model.value || row.dataset.model === model.value));
      if (!row.hidden) count += 1;
    });
    document.getElementById('observation-count').textContent = `${count} 组观测`;
    document.getElementById('observation-empty').hidden = count > 0;
  }
  search.addEventListener('input', apply);
  model.addEventListener('change', apply);
  apply();
})();

(() => {
  const search = document.getElementById('ranking-search');
  const history = document.getElementById('historical-reference');
  if (!search || !history) return;
  search.value = (new URLSearchParams(location.search).get('query') || '').slice(0, 253);
  const rows = Array.from(document.querySelectorAll('[data-history-domain]'));
  function apply() {
    const query = search.value.trim().toLowerCase();
    let count = 0;
    rows.forEach((row) => {
      row.hidden = !row.dataset.historyDomain.includes(query);
      if (!row.hidden) count += 1;
    });
    if (query && count) history.open = true;
  }
  search.addEventListener('input', apply);
  apply();
})();

(() => {
  const rows = Array.from(document.querySelectorAll('[data-rank-row]'));
  if (!rows.length) return;
  const search = document.getElementById('ranking-search');
  const visibleCount = document.getElementById('ranking-visible-count');
  const empty = document.getElementById('ranking-empty');
  let tone = 'all';
  let protocol = 'all';
  let watchedOnly = false;

  const initialQuery = new URLSearchParams(location.search).get('query');
  if (search && initialQuery) search.value = initialQuery.slice(0, 253);

  function watchedDomains() {
    try {
      const parsed = JSON.parse(localStorage.getItem('gewu:watched-relays:v1') || '[]');
      return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
    } catch { return new Set(); }
  }

  function apply() {
    const query = String(search?.value || '').trim().toLowerCase();
    const watched = watchedDomains();
    let visible = 0;
    const sectionCounts = {red: 0, black: 0};
    rows.forEach((row) => {
      const domain = String(row.dataset.domain || '');
      const protocols = String(row.dataset.protocols || '').split(/\s+/);
      const show = (!query || domain.includes(query))
        && (tone === 'all' || row.dataset.tone === tone)
        && (protocol === 'all' || protocols.includes(protocol))
        && (!watchedOnly || watched.has(domain));
      row.hidden = !show;
      if (show) { visible += 1; sectionCounts[row.dataset.tone] += 1; }
    });
    document.querySelectorAll('[data-ranking-section]').forEach((section) => {
      section.hidden = sectionCounts[section.dataset.rankingSection] === 0;
    });
    document.querySelectorAll('[data-section-count]').forEach((node) => {
      node.textContent = String(sectionCounts[node.dataset.sectionCount] || 0);
    });
    if (visibleCount) visibleCount.textContent = `${visible} \u5bb6\u53ef\u89c1`;
    if (empty) empty.hidden = visible !== 0;
  }

  search?.addEventListener('input', apply);
  document.querySelectorAll('[data-rank-tone]').forEach((button) => {
    button.addEventListener('click', () => {
      tone = button.dataset.rankTone || 'all';
      document.querySelectorAll('[data-rank-tone]').forEach((item) => item.classList.toggle('is-active', item === button));
      apply();
    });
  });
  document.querySelectorAll('[data-rank-protocol]').forEach((button) => {
    button.addEventListener('click', () => {
      protocol = button.dataset.rankProtocol || 'all';
      document.querySelectorAll('[data-rank-protocol]').forEach((item) => item.classList.toggle('is-active', item === button));
      apply();
    });
  });
  document.querySelectorAll('[data-rank-watch]').forEach((button) => {
    button.addEventListener('click', () => {
      watchedOnly = !watchedOnly;
      button.classList.toggle('is-active', watchedOnly);
      button.setAttribute('aria-pressed', watchedOnly ? 'true' : 'false');
      apply();
    });
  });
  window.addEventListener('gewu:watch-changed', apply);
  apply();
})();

// Local watchlist and session-scoped comparison. Domains are validated before
// storage or URL construction; API keys and detector inputs are never stored.
(() => {
  const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9.-]{1,251}[a-z0-9])$/;
  const WATCH_KEY = 'gewu:watched-relays:v1';
  const COMPARE_KEY = 'gewu:compare-relays:v1';
  const normalize = (value) => {
    const domain = String(value || '').trim().toLowerCase();
    return domain.includes('.') && DOMAIN_RE.test(domain) ? domain : '';
  };
  const readSet = (storage, key) => {
    try {
      const parsed = JSON.parse(storage.getItem(key) || '[]');
      return new Set((Array.isArray(parsed) ? parsed : []).map(normalize).filter(Boolean));
    } catch { return new Set(); }
  };
  const writeSet = (storage, key, values) => {
    try { storage.setItem(key, JSON.stringify(Array.from(values).slice(0, 50))); } catch { /* storage unavailable */ }
  };

  let watched = readSet(localStorage, WATCH_KEY);
  const watchButtons = Array.from(document.querySelectorAll('[data-watch-domain]'));
  function renderWatch() {
    watchButtons.forEach((button) => {
      const active = watched.has(normalize(button.dataset.watchDomain));
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      button.classList.toggle('is-active', active);
      button.textContent = active ? '已关注' : '关注';
    });
  }
  watchButtons.forEach((button) => button.addEventListener('click', () => {
    const domain = normalize(button.dataset.watchDomain);
    if (!domain) return;
    if (watched.has(domain)) watched.delete(domain); else watched.add(domain);
    writeSet(localStorage, WATCH_KEY, watched);
    renderWatch();
    window.dispatchEvent(new CustomEvent('gewu:watch-changed'));
  }));
  renderWatch();

  let compared = new Set(Array.from(readSet(sessionStorage, COMPARE_KEY)).slice(0, 3));
  const queryDomains = new URLSearchParams(location.search).get('domains');
  if (location.pathname === '/leaderboard/compare' && queryDomains) {
    compared = new Set(queryDomains.split(',').map(normalize).filter(Boolean).slice(0, 3));
    writeSet(sessionStorage, COMPARE_KEY, compared);
  }
  const compareButtons = Array.from(document.querySelectorAll('[data-compare-domain]'));
  const removeButtons = Array.from(document.querySelectorAll('[data-compare-remove]'));
  const bar = document.getElementById('compare-selection-bar');
  const count = document.getElementById('compare-selection-count');
  const open = document.getElementById('compare-selection-open');
  const clear = document.getElementById('compare-selection-clear');
  const compareUrl = () => `/leaderboard/compare?${new URLSearchParams({domains: Array.from(compared).join(',')})}`;
  function renderCompare() {
    compareButtons.forEach((button) => {
      const active = compared.has(normalize(button.dataset.compareDomain));
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      button.classList.toggle('is-active', active);
      button.textContent = active ? '已选' : '对比';
    });
    if (count) count.textContent = String(compared.size);
    if (bar) bar.hidden = compared.size === 0;
    if (open) {
      open.href = compareUrl();
      open.setAttribute('aria-disabled', compared.size < 2 ? 'true' : 'false');
    }
  }
  compareButtons.forEach((button) => button.addEventListener('click', () => {
    const domain = normalize(button.dataset.compareDomain);
    if (!domain) return;
    if (compared.has(domain)) compared.delete(domain);
    else if (compared.size < 3) compared.add(domain);
    writeSet(sessionStorage, COMPARE_KEY, compared);
    renderCompare();
  }));
  removeButtons.forEach((button) => button.addEventListener('click', () => {
    const domain = normalize(button.dataset.compareRemove);
    compared.delete(domain);
    writeSet(sessionStorage, COMPARE_KEY, compared);
    location.href = compareUrl();
  }));
  clear?.addEventListener('click', () => {
    compared.clear();
    writeSet(sessionStorage, COMPARE_KEY, compared);
    renderCompare();
  });
  open?.addEventListener('click', (event) => {
    if (compared.size < 2) event.preventDefault();
  });
  renderCompare();
})();

// Price workbench filters and explicit presentation sorting. The server keeps
// the market directory order; the browser never recalculates or mixes units.
(() => {
  document.querySelectorAll('[data-pricing-workbench]').forEach((workbench) => {
    const rows = Array.from(workbench.querySelectorAll('[data-pricing-row]'));
    if (!rows.length) return;
    const search = workbench.querySelector('[data-pricing-search]');
    const billing = workbench.querySelector('[data-pricing-billing]');
    const ability = workbench.querySelector('[data-pricing-ability]');
    const sort = workbench.querySelector('[data-pricing-sort]');
    const visibleCount = workbench.closest('.pricing-models')?.querySelector('#pricing-visible-count');
    const empty = workbench.querySelector('[data-pricing-empty]');
    const feedback = workbench.querySelector('[data-pricing-feedback]');
    const tableBody = rows[0].parentElement;
    let vendor = 'all';

    function sourceOrder(row) {
      return Number.parseInt(row.dataset.sourceOrder || '', 10) || 0;
    }

    function priceValue(row, key) {
      const raw = String(row.dataset[key] || '');
      if (!raw) return Number.POSITIVE_INFINITY;
      const value = Number(raw);
      if (!Number.isFinite(value)) return Number.POSITIVE_INFINITY;
      return value === -1 ? Number.NEGATIVE_INFINITY : value;
    }

    function applyPricingSort() {
      if (!tableBody) return;
      const mode = String(sort?.value || 'source');
      const billingOrder = ['usage', 'count', 'video_size', 'av_duration'];
      const ordered = [...rows].sort((left, right) => {
        let result = 0;
        if (mode === 'price-asc') {
          // Keep unlike units in separate groups when "all billing" is shown.
          result = billingOrder.indexOf(left.dataset.billing) - billingOrder.indexOf(right.dataset.billing);
          if (result) return result;
          result = priceValue(left, 'price') - priceValue(right, 'price');
        } else if (mode === 'output-asc') {
          result = billingOrder.indexOf(left.dataset.billing) - billingOrder.indexOf(right.dataset.billing);
          if (result) return result;
          result = priceValue(left, 'outputPrice') - priceValue(right, 'outputPrice');
        } else if (mode === 'published-desc') {
          result = String(right.dataset.published || '').localeCompare(String(left.dataset.published || ''));
        }
        return result || sourceOrder(left) - sourceOrder(right);
      });
      ordered.forEach((row) => tableBody.appendChild(row));
    }

    function applyPricingFilters() {
      const query = String(search?.value || '').trim().toLowerCase();
      const billingValue = String(billing?.value || 'all');
      const abilityValue = String(ability?.value || 'all').toLowerCase();
      let visible = 0;
      rows.forEach((row) => {
        const abilities = String(row.dataset.abilities || '').split('|');
        const show = (!query || String(row.dataset.model || '').includes(query))
          && (vendor === 'all' || row.dataset.vendor === vendor)
          && (billingValue === 'all' || row.dataset.billing === billingValue)
          && (abilityValue === 'all' || abilities.includes(abilityValue));
        row.hidden = !show;
        if (show) visible += 1;
      });
      if (visibleCount) visibleCount.textContent = `${visible} 个计费版本`;
      if (empty) empty.hidden = visible !== 0;
    }

    search?.addEventListener('input', applyPricingFilters);
    billing?.addEventListener('change', applyPricingFilters);
    ability?.addEventListener('change', applyPricingFilters);
    sort?.addEventListener('change', applyPricingSort);
    workbench.querySelectorAll('[data-pricing-vendor]').forEach((button) => {
      button.addEventListener('click', () => {
        vendor = button.dataset.pricingVendor || 'all';
        workbench.querySelectorAll('[data-pricing-vendor]').forEach((item) => {
          item.classList.toggle('is-active', item === button);
        });
        applyPricingFilters();
      });
    });
    workbench.querySelectorAll('[data-pricing-test-model]').forEach((button) => {
      button.addEventListener('click', () => {
        const quickCheck = document.getElementById('quick-check');
        const modelInput = document.getElementById('quick-model');
        const baseUrlInput = document.getElementById('quick-base-url');
        if (!quickCheck || !modelInput) return;
        const model = String(button.dataset.pricingTestModel || '').slice(0, 120);
        const protocol = String(button.dataset.pricingTestProtocol || 'openai');
        const vendorInput = document.getElementById('quick-vendor');
        if (vendorInput) {
          const catalog = JSON.parse(vendorInput.dataset.catalog || '[]');
          const vendor = catalog.find(v => v.models.some(m => m.id === model));
          vendorInput.value = vendor?.id || ({claude: 'anthropic', gemini: 'google'}[protocol] || 'other');
          vendorInput.dispatchEvent(new Event('change', {bubbles: true}));
          modelInput.disabled = false;
        }
        if (!Array.from(modelInput.options).some(option => option.value === model)) {
          modelInput.add(new Option(`${model}（价格榜候选）`, model));
        }
        modelInput.value = model;
        quickCheck.classList.remove('is-prefilled');
        void quickCheck.offsetWidth;
        quickCheck.classList.add('is-prefilled');
        if (feedback) feedback.textContent = `已把 ${model} 带入检测面板；补充中转站 URL 后即可继续。`;
        quickCheck.scrollIntoView({behavior: 'smooth', block: 'center'});
        window.setTimeout(() => baseUrlInput?.focus({preventScroll: true}), 350);
      });
    });
    applyPricingSort();
    applyPricingFilters();
  });
})();
