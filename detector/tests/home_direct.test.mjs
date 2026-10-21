import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../web/static/home-detect.js', import.meta.url), 'utf8');
const catalog = JSON.parse(readFileSync(new URL('../src/relay_detector/data/model_catalog.json', import.meta.url), 'utf8')).vendors
  .map(vendor => ({...vendor, models: vendor.models.map(id => ({id, label: id}))}));
catalog.push({id: 'other', route: 'openai', models: []});
const KEY = 'fixture-home-key-not-a-secret';
const JOB = 'fixturejob001';
const response = (body, status = 200) => ({ok: status >= 200 && status < 300, status, json: async () => body});
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function element(id, value = '') {
  const listeners = {};
  return {id, value, options: [], dataset: {}, attributes: {}, disabled: false, hidden: true, textContent: '',
    focus: vi.fn(),
    hasAttribute(name) { return Object.hasOwn(this.attributes, name); },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, fn) { (listeners[name] ||= []).push(fn); },
    async emit(name, event = {}) { await Promise.all((listeners[name] || []).map(fn => fn(event))); },
    dispatchEvent(event) { (listeners[event.type] || []).forEach(fn => fn(event)); },
    replaceChildren(...nodes) { this.options = nodes; },
  };
}
function fixture({vendor = 'openai', url = 'https://gewu.example/'} = {}) {
  const ids = Object.fromEntries(['quick-check', 'quick-base-url', 'quick-api-key', 'quick-vendor', 'quick-model',
    'quick-mode', 'quick-wire', 'quick-start', 'quick-load-models', 'quick-check-error', 'quick-model-hint',
    'quick-plan-label', 'quick-budget', 'quick-coverage'].map(id => [id, element(id)]));
  const form = ids['quick-check']; form.attributes['data-direct-detection'] = '';
  form.querySelectorAll = () => ['quick-base-url', 'quick-api-key', 'quick-vendor', 'quick-model', 'quick-mode', 'quick-wire', 'quick-start', 'quick-load-models'].map(id => ids[id]);
  ids['quick-vendor'].value = vendor;
  ids['quick-vendor'].dataset.catalog = JSON.stringify(catalog);
  form.dataset.responsesPlan = JSON.stringify({requests: {quick: 2, standard: 8, full: 12}, checks: {quick: 2, standard: 6, full: 10}});
  ids['quick-mode'].value = 'full';
  ids['quick-base-url'].value = 'https://relay.example/v1';
  ids['quick-api-key'].value = KEY;
  const window = element('window'), timers = new Map(); let counter = 0;
  const parsed = new URL(url);
  const location = {protocol: parsed.protocol, hostname: parsed.hostname, assign: vi.fn()};
  const storage = {setItem: vi.fn(() => { throw new Error('Key handoff must not use browser storage'); }), getItem: vi.fn()};
  const calls = [];
  const handler = vi.fn(async () => response({job_id: JOB}));
  const context = {document: {getElementById: id => ids[id] || null}, window, location, URL, FormData, AbortController, Event,
    sessionStorage: storage, localStorage: storage,
    Option: function(label, value) { this.label = label; this.value = value; },
    setTimeout: (fn, ms) => { const id = ++counter; timers.set(id, {fn, ms}); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => {
      calls.push({url, data: Object.fromEntries(options.body), signal: options.signal, method: options.method});
      return handler(url, options);
    },
  };
  runInNewContext(source, context, {timeout: 1000});
  const entry = catalog.find(v => v.id === vendor);
  ids['quick-model'].value = entry.models[0]?.id || '';
  return {ids, form, window, timers, location, storage, calls, handler,
    submit: () => form.emit('submit', {preventDefault: vi.fn()}),
    change: async (id, value, event = 'change') => { ids[id].value = value; await ids[id].emit(event); },
  };
}

describe('Homepage directly starts a real job, without a confirmation page', () => {
  it('never sends credentials while a visitor is typing or changing options', async () => {
    const f = fixture();
    await f.change('quick-base-url', 'https://relay.example/v1', 'input');
    await f.change('quick-api-key', KEY, 'input');
    await f.change('quick-mode', 'full');
    await f.change('quick-wire', 'chat_completions');
    expect(f.calls).toEqual([]);
    expect(f.storage.setItem).not.toHaveBeenCalled();
  });

  it.each(catalog.filter(v => v.id !== 'other').map(v => [v.id, v.route]))('%s starts the selected protocol and opens only its job page', async (vendor, route) => {
    const f = fixture({vendor});
    await f.submit();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe('/api/detect/' + route);
    expect(f.calls[0].data).toMatchObject({base_url: 'https://relay.example/v1', api_key: KEY,
      mode: 'full', force: 'true', include_long_context: 'false', include_long_context_extreme: 'false'});
    expect(f.calls[0].data.wire_api).toBe(vendor === 'openai' ? 'responses' : route === 'claude' ? 'messages' : 'chat_completions');
    expect(f.calls[0].data.responses_suite).toBe(vendor === 'openai' ? 'extended' : undefined);
    expect(f.location.assign).toHaveBeenCalledExactlyOnceWith('/r/' + JOB);
    expect(f.ids['quick-api-key'].value).toBe('');
    expect(f.storage.setItem).not.toHaveBeenCalled();
    expect(f.ids['quick-start'].disabled).toBe(true);
    expect(f.timers.size).toBe(0);
  });

  it('discloses the expanded ten-check plan and request cap before submission', async () => {
    const f = fixture();
    expect(f.ids['quick-mode'].value).toBe('full');
    expect(f.ids['quick-coverage'].textContent).toContain('10 项');
    expect(f.ids['quick-budget'].textContent).toContain('最多 12 次');
    expect(f.calls).toHaveLength(0);
    await f.change('quick-mode', 'standard');
    expect(f.ids['quick-coverage'].textContent).toContain('6 项');
    expect(f.ids['quick-budget'].textContent).toContain('最多 8 次');
    await f.change('quick-mode', 'quick');
    expect(f.ids['quick-budget'].textContent).toContain('最多 2 次');
    await f.submit();
    expect(f.calls[0].data).toMatchObject({mode: 'quick', responses_suite: 'extended'});
  });

  it('keeps interface and depth explicit, with long-context probes always off', async () => {
    const f = fixture({vendor: 'google'});
    await f.change('quick-mode', 'full');
    await f.change('quick-wire', 'generate_content');
    expect(f.ids['quick-load-models'].disabled).toBe(true);
    expect(f.ids['quick-budget'].textContent).toContain('最多 5 次');
    await f.submit();
    expect(f.calls[0].data).toMatchObject({wire_api: 'generate_content', mode: 'full', force: 'true', include_long_context: 'false'});
  });

  it.each(['', 'javascript:alert(1)', 'https://u:p@relay.example', 'https://relay.example?key=synthetic',
    'https://relay.example/#private', 'https://relay.example/a\nb', 'https://relay.example/' + 'a'.repeat(2048)])('rejects unsafe addresses without a request', async url => {
    const f = fixture(); f.ids['quick-base-url'].value = url;
    await f.submit();
    expect(f.calls).toEqual([]); expect(f.ids['quick-check-error'].hidden).toBe(false);
  });

  it.each(['', 'short', 'fixture\nkey', 'a'.repeat(4097)])('rejects invalid keys before sending', async key => {
    const f = fixture(); f.ids['quick-api-key'].value = key;
    await f.submit(); expect(f.calls).toEqual([]);
    expect(f.ids['quick-api-key'].focus).toHaveBeenCalled();
  });

  it('requires an explicit model, including for other vendors', async () => {
    for (const vendor of ['openai', 'other']) {
      const f = fixture({vendor}); f.ids['quick-model'].value = '';
      await f.submit(); expect(f.calls).toEqual([]);
      expect(f.ids['quick-check-error'].textContent).toContain('选择目标模型');
    }
  });

  it.each([['quick-mode', 'unexpected'], ['quick-wire', 'messages']])('rejects forged %s choices', async (id, value) => {
    const f = fixture(); f.ids[id].value = value;
    await f.submit(); expect(f.calls).toEqual([]);
  });

  it('trims pasted credentials but never puts them in navigation URLs', async () => {
    const f = fixture(); f.ids['quick-api-key'].value = ` ${KEY} `; f.ids['quick-base-url'].value += ' ';
    await f.submit();
    expect(f.calls[0].data.api_key).toBe(KEY);
    expect(f.calls[0].data.base_url).toBe('https://relay.example/v1');
    expect(f.location.assign.mock.calls.flat().join(' ')).not.toContain(KEY);
  });

  it('prevents double clicks while submission is pending', async () => {
    const f = fixture(); let finish;
    f.handler.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const first = f.submit(); await tick();
    await f.submit();
    expect(f.calls).toHaveLength(1);
    expect(f.ids['quick-start'].disabled).toBe(true);
    finish(response({job_id: JOB})); await first;
    expect(f.location.assign).toHaveBeenCalledOnce();
  });

  it('permits correcting a definite rejection without exposing a reflected Key', async () => {
    const f = fixture();
    f.handler.mockResolvedValue(response({detail: `拒绝 ${KEY} <script>`}, 400));
    await f.submit();
    expect(f.ids['quick-start'].disabled).toBe(false);
    expect(f.ids['quick-check-error'].textContent).toBe('拒绝 [已隐藏] <script>');
    expect(f.ids['quick-api-key'].value).toBe(KEY);
    expect(f.location.assign).not.toHaveBeenCalled();
  });

  it.each(['network', 'server', 'bad-job'])('does not automatically retry an ambiguous %s outcome', async failure => {
    const f = fixture();
    if (failure === 'network') f.handler.mockRejectedValue(new Error('network'));
    else if (failure === 'server') f.handler.mockResolvedValue(response({}, 500));
    else f.handler.mockResolvedValue(response({job_id: 'https://evil.example/redirect'}));
    await f.submit(); await f.submit();
    expect(f.calls).toHaveLength(1);
    expect(f.ids['quick-start'].disabled).toBe(true);
    expect(f.ids['quick-check-error'].textContent).toContain('不会自动重试');
    expect(f.location.assign).not.toHaveBeenCalled();
    expect(f.timers.size).toBe(0);
  });

  it('blocks insecure public origins, including the optional model request', async () => {
    const f = fixture({url: 'http://public.example/'});
    expect(f.ids['quick-start'].disabled).toBe(true);
    expect(f.ids['quick-load-models'].disabled).toBe(true);
    await f.submit(); await f.ids['quick-load-models'].emit('click');
    expect(f.calls).toEqual([]);
  });

  it('aborts and clears secrets on pagehide without a stale redirect after history restoration', async () => {
    const f = fixture(); let finish;
    f.handler.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const submit = f.submit(); await tick();
    await f.window.emit('pagehide');
    expect(f.calls[0].signal.aborted).toBe(true);
    expect(f.ids['quick-api-key'].value).toBe('');
    await f.window.emit('pageshow', {persisted: true});
    finish(response({job_id: JOB})); await submit;
    expect(f.location.assign).not.toHaveBeenCalled();
    expect(f.ids['quick-start'].disabled).toBe(false);
    expect(f.timers.size).toBe(0);
  });

  it('ignores a late response body after leaving and restoring the page', async () => {
    const f = fixture(); let finishBody;
    f.handler.mockResolvedValue({ok: true, status: 200, json: () => new Promise(resolve => { finishBody = resolve; })});
    const submit = f.submit(); await tick();
    await f.window.emit('pagehide'); await f.window.emit('pageshow', {persisted: true});
    f.ids['quick-api-key'].value = 'new-fixture-key';
    finishBody({job_id: JOB}); await submit;
    expect(f.location.assign).not.toHaveBeenCalled();
    expect(f.ids['quick-api-key'].value).toBe('new-fixture-key');
    expect(f.ids['quick-start'].disabled).toBe(false);
  });

  it('loads declared models only after the optional explicit click and never auto-selects one', async () => {
    const f = fixture({vendor: 'other'});
    f.handler.mockResolvedValue(response({ok: true, models_endpoint_supported: true, by_vendor: {other: ['custom-model']}}));
    await f.ids['quick-load-models'].emit('click');
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({url: '/api/probe', data: {base_url: 'https://relay.example/v1', api_key: KEY}});
    expect(f.ids['quick-model'].options.map(o => o.value)).toEqual(['', 'custom-model']);
    expect(f.ids['quick-model'].value).toBe('');
    expect(f.location.assign).not.toHaveBeenCalled();
    expect(f.timers.size).toBe(0);
  });

  it('does not replace the current vendor with another vendor’s declared models', async () => {
    const f = fixture({vendor: 'deepseek'});
    f.handler.mockResolvedValue(response({ok: true, models_endpoint_supported: true,
      by_vendor: {openai: ['gpt-foreign']}, by_protocol: {openai: ['gpt-foreign']}}));
    await f.ids['quick-load-models'].emit('click');
    expect(f.ids['quick-model'].options.map(o => o.value)).toEqual(['']);
  });

  it('ignores a late model response after the address or Key changes', async () => {
    const f = fixture(); let finish;
    f.handler.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const loading = f.ids['quick-load-models'].emit('click'); await tick();
    await f.change('quick-base-url', 'https://different.example/v1', 'input');
    finish(response({ok: true, models_endpoint_supported: true, by_responses_vendor: {openai: ['stale-model']}}));
    await loading;
    expect(f.calls[0].signal.aborted).toBe(true);
    expect(f.ids['quick-model'].options.some(o => o.value === 'stale-model')).toBe(false);
    expect(f.timers.size).toBe(0);
  });
});
