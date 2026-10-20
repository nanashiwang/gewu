import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../web/static/app.js', import.meta.url), 'utf8');
const extract = (from, to) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error('Script section not found');
  return source.slice(start, end);
};
const launcher = extract('// Legacy protocol-page URL handoff.', '// Client-side leaderboard');
const transport = extract('// Refuse to collect API keys', '// Keep a prepared password');
const clearPassword = extract('// Keep a prepared password', '// Native selects');
const probe = extract('// Pre-submission probe:', '\n\n(function () {\n  const form = document.getElementById(\'detect-form\');');
const KEY = 'fixture-home-key-not-a-secret';

function control(value = '', extra = {}) {
  const listeners = {};
  return { value, disabled: false, dataset: {}, hidden: true, focus: vi.fn(),
    addEventListener: (name, fn) => { (listeners[name] ||= []).push(fn); },
    emit: (name, event) => listeners[name]?.forEach(fn => fn(event)),
    removeAttribute: vi.fn(), setAttribute: vi.fn(), appendChild: vi.fn(),
    prepend: vi.fn(), ...extra };
}

function fixture({ prepared = false, url = 'https://gewu.example/', vendor = 'openai' } = {}) {
  const button = control();
  const form = control('', { dataset: prepared ? { endpoint: '/api/detect/openai', prepared: 'true' } : {},
    querySelector: () => button });
  const field = control();
  const key = control(KEY, { closest: () => field });
  const base = control('https://relay.example/v1');
  const model = control('gpt-6-astra');
  const vendorInput = control(vendor, { dataset: { catalog: JSON.stringify([
    {id: 'openai', route: 'openai', models: [{id: 'gpt-6-astra', label: 'GPT'}]},
    {id: 'other', route: 'openai', models: []},
  ]) } });
  const error = control();
  const ids = prepared
    ? { 'detect-form': form, api_key: key, base_url: base, model, 'submit-btn': button }
    : { 'quick-check': form, 'quick-api-key': key, 'quick-base-url': base,
      'quick-model': model, 'quick-vendor': vendorInput, 'quick-check-error': error };
  const window = control();
  const storage = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() };
  const fetch = vi.fn(async () => ({ status: 200, json: async () => ({ ok: true, models_endpoint_supported: false }) }));
  const context = { document: { getElementById: id => ids[id] || null, createElement: () => control() },
    window, location: Object.freeze(new URL(url)), URL, URLSearchParams, FormData, AbortController,
    sessionStorage: storage, localStorage: storage, fetch, setTimeout: vi.fn(), clearTimeout: vi.fn(),
    Option: function (label, value) { this.label = label; this.value = value; } };
  return { context, form, key, base, model, vendorInput, error, storage, fetch, button, window,
    submit: () => { const event = { preventDefault: vi.fn() }; form.emit('submit', event); return event; } };
}

function run(script, context) { runInNewContext(script, context, { timeout: 1000 }); }

describe('Homepage Key handoff', () => {
  it.each([false, true])('blocks a public HTTP page before credentials can be sent (prepared=%s)', prepared => {
    const f = fixture({prepared, url: 'http://public.example/'});
    run(transport, f.context);
    expect(f.key.disabled).toBe(true);
    expect(f.button.disabled).toBe(true);
    expect(f.submit().preventDefault).toHaveBeenCalled();
  });

  it.each([false, true])('clears the live password on leaving the page (prepared=%s)', prepared => {
    const f = fixture({prepared});
    run(clearPassword, f.context);
    expect(f.key.value).toBe(KEY);
    expect(f.key.removeAttribute).toHaveBeenCalledWith('value');
    f.window.emit('pagehide');
    expect(f.key.value).toBe('');
  });

  it('does not override prepared fields from query parameters', () => {
    const f = fixture({prepared: true, url: 'https://gewu.example/api/status/prepare?base_url=https://evil.example&model=wrong'});
    run(launcher, f.context);
    expect(f.base.value).toBe('https://relay.example/v1');
    expect(f.model.value).toBe('gpt-6-astra');
  });

  it('cannot combine a stale handoff address with a freshly prepared Key', async () => {
    const f = fixture({prepared: true});
    f.storage.getItem.mockReturnValue(JSON.stringify({base_url: 'https://stale.example', from: 'anthropic'}));
    run(probe, f.context);
    expect(f.base.value).toBe('https://relay.example/v1');
    expect(f.storage.removeItem).toHaveBeenCalledWith('gewu:handoff');
    expect(f.fetch).toHaveBeenCalledOnce();
    const [url, options] = f.fetch.mock.calls[0];
    expect(url).toBe('/api/probe');
    expect(options.body.get('base_url')).toBe('https://relay.example/v1');
    expect(options.body.get('api_key')).toBe(KEY);
    expect(f.storage.setItem).not.toHaveBeenCalled();
    f.window.emit('pagehide');
    expect(options.signal.aborted).toBe(true);
    await Promise.resolve();
  });
});
