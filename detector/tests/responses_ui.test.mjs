import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../web/static/app.js', import.meta.url), 'utf8');
const end = source.indexOf("(function () {\n  const wire = document.getElementById('gemini-wire-api');");
if (end < 0) throw new Error('Responses UI boundary missing');
const script = source.slice(0, end);
const plan = {checks: {quick: 2, standard: 6, full: 10}, requests: {quick: 2, standard: 8, full: 12}};
function control(value = '') {
  const listeners = {};
  return {value, dataset: {}, disabled: false, hidden: false, textContent: '',
    addEventListener(event, fn) { (listeners[event] ||= []).push(fn); },
    dispatchEvent(event) { for (const fn of listeners[event.type] || []) fn(event); },
    change(value) { this.value = value; this.dispatchEvent(new Event('change')); },
  };
}
function fixture(configuration = plan) {
  const ids = Object.fromEntries(['wire-api', 'mode', 'model-vendor', 'responses-budget',
    'chat-advanced-options', 'responses-suite', 'detect-form', 'vendor-scope'].map(id => [id, control()]));
  ids['wire-api'].value = 'responses';
  ids.mode.value = 'full';
  ids.mode.options = ['quick', 'standard', 'full'].map(value => control(value));
  ids['detect-form'].dataset.responsesPlan = JSON.stringify(configuration);
  const longContext = {checked: true, disabled: false};
  ids['chat-advanced-options'].querySelectorAll = () => [longContext];
  const fetch = vi.fn(() => { throw new Error('Changing the plan must not send requests'); });
  runInNewContext(script, {document: {getElementById: id => ids[id]}, Event,
    queueMicrotask: fn => fn(), fetch}, {timeout: 1000});
  return {ids, longContext, fetch};
}

describe('Responses expanded plan disclosure', () => {
  it.each(['quick', 'standard', 'full'])('discloses %s budget without any inference', mode => {
    const {ids, longContext, fetch} = fixture();
    ids.mode.change(mode);
    expect(ids['responses-budget'].textContent).toContain(`${plan.checks[mode]} 项能力检查`);
    expect(ids['responses-budget'].textContent).toContain(`最多 ${plan.requests[mode]} 次请求`);
    expect(ids['responses-budget'].textContent).toContain('由你的 Key 支付');
    expect(ids['responses-suite'].disabled).toBe(false);
    expect(longContext.checked).toBe(false);
    expect(longContext.disabled).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('never submits the extended suite for Chat Completions or another vendor', () => {
    const {ids, fetch} = fixture();
    ids['wire-api'].change('chat_completions');
    expect(ids['responses-suite'].disabled).toBe(true);
    expect(ids['responses-budget'].hidden).toBe(true);
    ids['wire-api'].change('responses');
    expect(ids['responses-suite'].disabled).toBe(false);
    ids['model-vendor'].change('other');
    expect(ids['wire-api'].value).toBe('chat_completions');
    expect(ids['responses-suite'].disabled).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('gets displayed limits from server data rather than a second hard-coded budget', () => {
    const {ids} = fixture({checks: {...plan.checks, full: 11}, requests: {...plan.requests, full: 13}});
    expect(ids['responses-budget'].textContent).toContain('11 项能力检查，最多 13 次请求');
    expect(ids.mode.options[2].textContent).toContain('11 项能力');
  });
});
