import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../web/static/running.js', import.meta.url), 'utf8');
const JOB = 'fixturejob001';
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function node() {
  const listeners = {};
  return {textContent: '', hidden: false, disabled: false, children: [], dataset: {}, attributes: {},
    style: {setProperty: vi.fn()},
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, callback) { (listeners[name] ||= []).push(callback); },
    async emit(name, event = {}) { await Promise.all((listeners[name] || []).map(callback => callback(event))); },
    replaceChildren(...children) { this.children = children; },
    append(...children) { this.children.push(...children); },
  };
}
function fixture(job, handlerOverride) {
  const ids = Object.fromEntries(['running-config', 'status-headline', 'running-score', 'run-error', 'cancel-job',
    'refresh-progress', 'view-evidence', 'progress-bar', 'progress-track', 'stage-label', 'elapsed-label',
    'coverage-label', 'running-checks', 'running-spinner', 'running-meter', 'progress-count',
    'running-passed', 'running-failed'].map(id => [id, node()]));
  ids['running-config'].textContent = JSON.stringify({id: JOB, descriptions: {basic_request: '基础请求真实说明'}});
  ids['view-evidence'].hidden = true;
  const document = Object.assign(node(), {hidden: false, getElementById: id => ids[id] || null, createElement: () => node()});
  const window = node(), timers = new Map(); let counter = 0;
  const location = {replace: vi.fn()};
  const fetch = vi.fn(handlerOverride || (async () => ({ok: true, json: async () => job})));
  runInNewContext(source, {document, window, location, fetch, AbortController, Date, console,
    setTimeout: (fn, ms) => { const id = ++counter; timers.set(id, {fn, ms}); return id; },
    clearTimeout: id => timers.delete(id)}, {timeout: 1000});
  return {ids, document, window, timers, location, fetch,
    async nextPoll() { const entry = [...timers].find(([, value]) => value.ms === 2500); if (!entry) throw new Error('No poll scheduled'); timers.delete(entry[0]); await entry[1].fn(); await flush(); },
  };
}
function job(overrides = {}) {
  return {status: 'running', created_at: Date.now() / 1000 - 5,
    progress: {stage: 'probing', checks: [{name: 'basic_request', label: '基础请求', status: 'pass'},
      {name: 'stream', label: '流式检查', status: 'running'}]}, ...overrides};
}

describe('The second page follows progress into the report', () => {
  it('renders actual check states and counts without inventing a quality score', async () => {
    const f = fixture(job()); await flush();
    expect(f.ids['progress-count'].textContent).toBe('1/2');
    expect(f.ids['running-passed'].textContent).toBe('1');
    expect(f.ids['running-failed'].textContent).toBe('0');
    expect(f.ids['progress-track'].attributes['aria-valuenow']).toBe('50');
    expect(f.ids['running-score'].hidden).toBe(true);
    expect(f.ids['running-checks'].children[0].children[0].children[1].textContent).toBe('基础请求真实说明');
    expect(f.location.replace).not.toHaveBeenCalled();
    await f.window.emit('pagehide'); expect(f.timers.size).toBe(0);
  });

  it.each(['done', 'cancelled', 'interrupted', 'error'])('opens a ready %s report at the same URL exactly once', async status => {
    const f = fixture(job({status, result_url: '/r/' + JOB, total_score: 82, assessment: {score_usable: status === 'done'}}));
    await flush();
    expect(f.location.replace).toHaveBeenCalledExactlyOnceWith('/r/' + JOB);
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.fetch.mock.calls[0][0]).toBe('/api/status/' + JOB);
    expect(f.timers.size).toBe(0);
    expect(f.ids['running-score'].hidden).toBe(status !== 'done');
    await f.ids['refresh-progress'].emit('click');
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it.each([undefined, '/r/differentjob', 'https://evil.example/report'])('never follows an untrusted or absent result URL %s', async result_url => {
    const f = fixture(job({status: 'done', result_url, total_score: 100, assessment: {score_usable: false}}));
    await flush();
    expect(f.location.replace).not.toHaveBeenCalled();
    expect(f.ids['running-score'].hidden).toBe(true);
    expect(f.timers.size).toBe(0);
  });

  it('reloads a completed report without another detection POST', async () => {
    const f = fixture(job()); await flush();
    f.fetch.mockResolvedValue({ok: true, json: async () => job({status: 'done', result_url: '/r/' + JOB, assessment: {score_usable: false}})});
    await f.nextPoll();
    expect(f.location.replace).toHaveBeenCalledExactlyOnceWith('/r/' + JOB);
    expect(f.fetch.mock.calls.every(([url, options]) => url === '/api/status/' + JOB && !options.method)).toBe(true);
    expect(f.timers.size).toBe(0);
  });

  it('stops after bounded polling failures and only rereads status on manual refresh', async () => {
    const f = fixture(job(), async () => { throw new Error('offline'); }); await flush();
    for (let i = 1; i < 6; i++) await f.nextPoll();
    expect(f.fetch).toHaveBeenCalledTimes(6);
    expect(f.ids['refresh-progress'].hidden).toBe(false);
    expect(f.timers.size).toBe(0);
    f.fetch.mockResolvedValue({ok: true, json: async () => job()});
    await f.ids['refresh-progress'].emit('click'); await flush();
    expect(f.fetch.mock.calls.every(([url]) => url === '/api/status/' + JOB)).toBe(true);
    await f.window.emit('pagehide'); expect(f.timers.size).toBe(0);
  });

  it('aborts its owned fetch and leaves no polling timers after the page closes', async () => {
    const f = fixture(job(), (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    await f.window.emit('pagehide'); await flush();
    expect(f.fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(f.timers.size).toBe(0);
    expect(f.location.replace).not.toHaveBeenCalled();
  });
});
