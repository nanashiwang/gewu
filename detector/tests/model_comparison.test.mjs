import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
const source = readFileSync(new URL('../web/static/model-comparison.js', import.meta.url), 'utf8');
let window;
afterEach(async () => { await window?.happyDOM.close(); });
function setup(query = '', extraRows = 0) {
  window = new Window({url: 'https://gewu.example/leaderboard/models/compare?model=gpt-example&billing=1' + query,
    settings: { enableJavaScriptEvaluation: false, disableJavaScriptFileLoading: true, disableCSSFileLoading: true }});
  const document = window.document;
  document.body.innerHTML = `<input id="mc-search"><select id="mc-shop"><option value="">全部</option><option value="站点甲">甲</option><option value="站点乙">乙</option></select>
  <select id="mc-sort"><option value="source">默认</option><option value="price">价格</option><option value="stability">稳定性</option><option value="grade">评级</option></select>
  <button data-mc-grade="">全部<strong></strong></button><button data-mc-grade="S">S<strong></strong></button><button data-mc-grade="C">C<strong></strong></button><button data-mc-grade="unrated">未评级<strong></strong></button>
  <input type="checkbox" id="mc-rated"><input type="checkbox" id="mc-monitored">
  <button id="mc-reset">重置</button><span id="mc-count"></span><p id="mc-empty" hidden>空</p><table><tbody id="mc-rows">
  <tr class="mc-row" data-rank="0" data-grade="S" data-shop="站点甲" data-search="站点甲 codex" data-price="1" data-stability="98"></tr>
  <tr class="mc-row" data-rank="1" data-grade="C" data-shop="站点乙" data-search="站点乙 default" data-price="0.2" data-stability="80"></tr>
  <tr class="mc-row" data-rank="2" data-grade="unrated" data-shop="站点甲" data-search="站点甲 default" data-price="" data-stability=""></tr>
  </tbody></table>`;
  const body = document.getElementById('mc-rows');
  for (let i = 0; i < extraRows; i++) {
    const row = body.firstElementChild.cloneNode(true);
    row.dataset.rank = String(i + 3);
    row.dataset.price = String(i + 2);
    body.appendChild(row);
  }
  for (const [i, row] of [...body.children].entries()) {
    row.innerHTML = `<td><button class="mc-detail-toggle" aria-expanded="false" aria-controls="detail-${i}">detail <span>+</span></button></td>`;
    const detail = document.createElement('tr');
    detail.id = `detail-${i}`; detail.className = 'mc-detail-row'; detail.hidden = true;
    detail.innerHTML = `<td colspan="9">Detail ${i}</td>`;
    row.after(detail);
  }
  const nav = document.createElement('nav');nav.className = 'mc-pagination';
  nav.innerHTML = '<span id="mc-page-info"></span><button id="mc-prev">prev</button><span id="mc-page-number"></span><button id="mc-next">next</button>';
  document.body.appendChild(nav);
  runInNewContext(source, {document, window, URL}, {timeout:1000});
  return { document, visible: () => [...document.querySelectorAll('.mc-row')].filter(r => !r.hidden),
    set: (id, value, event = 'change') => { const e=document.getElementById(id);e.value=value;e.dispatchEvent(new window.Event(event)); } };
}
describe('model route comparison navigation state', () => {
  it('restores shared filters and preserves model and billing when changed', () => {
    const f = setup('&grade=S&shop=' + encodeURIComponent('站点甲'));
    expect(f.visible()).toHaveLength(1);
    expect(f.document.querySelector('[data-mc-grade="S"]').getAttribute('aria-pressed')).toBe('true');
    f.set('mc-search', 'codex', 'input');
    const url = new URL(window.location.href);
    expect(url.searchParams.get('q')).toBe('codex');
    expect(url.searchParams.get('model')).toBe('gpt-example');
    expect(url.searchParams.get('billing')).toBe('1');
  });
  it('resets controls and URL together, including empty search results', () => {
    const f = setup('&grade=C');
    f.set('mc-search','无匹配','input');
    expect(f.visible()).toHaveLength(0);
    expect(f.document.getElementById('mc-empty').hidden).toBe(false);
    f.document.getElementById('mc-reset').click();
    expect(f.visible()).toHaveLength(3);
    expect(f.document.getElementById('mc-reset').disabled).toBe(true);
    expect(new URL(window.location.href).search).toBe('?model=gpt-example&billing=1');
  });
  it('handles history changes and rejects unknown filter values', () => {
    const f = setup('&grade=bad&shop=bad&sort=bad');
    expect(f.visible()).toHaveLength(3);
    window.history.pushState(null,'','?model=gpt-example&billing=1&grade=S');
    window.dispatchEvent(new window.PopStateEvent('popstate'));
    expect(f.visible()).toHaveLength(1);
  });
  it('sorts numeric prices and stability with unknowns last', () => {
    const f = setup();
    f.set('mc-sort','price');
    expect(f.visible().map(r=>r.dataset.price)).toEqual(['0.2','1','']);
    f.set('mc-sort','stability');
    expect(f.visible().map(r=>r.dataset.stability)).toEqual(['98','80','']);
  });
});


describe('comparison pagination and inline details', () => {
  it('paginates after filtering, preserves query and resets to first page on changes', () => {
    const f = setup('', 57);
    expect(f.visible()).toHaveLength(25);
    f.document.getElementById('mc-next').click();
    expect(f.visible()[0].dataset.rank).toBe('25');
    expect(new URL(window.location.href).searchParams.get('page')).toBe('2');
    f.set('mc-shop', '站点乙');
    expect(f.visible()).toHaveLength(1);
    expect(new URL(window.location.href).searchParams.has('page')).toBe(false);
    expect(f.document.querySelector('.mc-pagination').hidden).toBe(true);
  });
  it('restores and bounds a page supplied in the URL', () => {
    const f = setup('&page=999',57);
    expect(f.visible()).toHaveLength(10);
    expect(f.document.getElementById('mc-page-number').textContent).toBe('3 / 3');
    expect(f.document.getElementById('mc-next').disabled).toBe(true);
    f.document.getElementById('mc-prev').click();
    expect(f.visible()).toHaveLength(25);
    expect(f.document.getElementById('mc-page-number').textContent).toBe('2 / 3');
  });
  it('keeps expanded details paired with their row through sorting and pagination', () => {
    const f = setup('',57);
    const row = f.visible()[0], button = row.querySelector('button');
    const detail = f.document.getElementById(button.getAttribute('aria-controls'));
    button.click();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(detail.hidden).toBe(false);
    f.document.getElementById('mc-next').click();
    expect(detail.hidden).toBe(true);
    f.document.getElementById('mc-prev').click();
    expect(detail.hidden).toBe(false);
    f.set('mc-sort','price');
    expect(row.nextElementSibling).toBe(detail);
    expect(detail.hidden).toBe(false);
    button.click();expect(detail.hidden).toBe(true);
  });
});


describe('comparison data availability filters', () => {
  it('updates facet counts for the selected platform without narrowing them to the selected grade', () => {
    const f = setup();
    f.set('mc-shop','站点甲');
    const count = grade => f.document.querySelector(`[data-mc-grade="${grade}"] strong`).textContent;
    expect(count('')).toBe('2'); expect(count('S')).toBe('1'); expect(count('C')).toBe('0');
    f.document.querySelector('[data-mc-grade="S"]').click();
    expect(f.visible()).toHaveLength(1);expect(count('')).toBe('2');expect(count('unrated')).toBe('1');
  });
  it('restores data filters from URL and clears them on reset', () => {
    const f = setup('&rated=1&monitored=1');
    expect(f.visible()).toHaveLength(2);
    expect(f.document.getElementById('mc-rated').checked).toBe(true);
    f.document.getElementById('mc-reset').click();
    expect(f.visible()).toHaveLength(3);
    expect(f.document.getElementById('mc-rated').checked).toBe(false);
    expect(f.document.getElementById('mc-monitored').checked).toBe(false);
    expect(new URL(window.location.href).search).toBe('?model=gpt-example&billing=1');
  });
  it('keeps real zero stability while excluding missing data and official baselines from rated-only', () => {
    const f = setup();
    const rows=f.document.querySelectorAll('.mc-row');
    rows[0].dataset.stability='0';rows[1].dataset.grade='official';
    const monitored=f.document.getElementById('mc-monitored');monitored.checked=true;monitored.dispatchEvent(new window.Event('change'));
    expect(f.visible()).toHaveLength(2);
    const rated=f.document.getElementById('mc-rated');rated.checked=true;rated.dispatchEvent(new window.Event('change'));
    expect(f.visible()).toHaveLength(1);expect(f.visible()[0].dataset.stability).toBe('0');
    expect(new URL(window.location.href).searchParams.get('rated')).toBe('1');
    expect(new URL(window.location.href).searchParams.get('monitored')).toBe('1');
  });
  it('keeps the selected grade when a platform change has no matching results', () => {
    const f=setup('&grade=C');f.set('mc-shop','站点甲');
    expect(f.visible()).toHaveLength(0);
    expect(f.document.querySelector('[data-mc-grade="C"]').getAttribute('aria-pressed')).toBe('true');
    expect(f.document.getElementById('mc-empty').hidden).toBe(false);
    expect(f.document.querySelector('[data-mc-grade="S"] strong').textContent).toBe('1');
  });
});
