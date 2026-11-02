(() => {
  const body = document.getElementById('mc-rows');
  if (!body) return;
  const rows = Array.from(body.querySelectorAll('.mc-row'));
  const search = document.getElementById('mc-search');
  const gradeTabs = Array.from(document.querySelectorAll('[data-mc-grade]'));
  const shop = document.getElementById('mc-shop');
  const sort = document.getElementById('mc-sort');
  const reset = document.getElementById('mc-reset');
  const rated = document.getElementById('mc-rated');
  const monitored = document.getElementById('mc-monitored');
  const pagination = document.querySelector('.mc-pagination');
  const previous = document.getElementById('mc-prev');
  const next = document.getElementById('mc-next');
  const pageSize = 25;
  let selectedGrade = '', page = 1, pageCount = 1;
  const grades = { official: 0, S: 1, A: 2, B: 3, C: 4, unrated: 5 };
  const numeric = (row, key, fallback) => row.dataset[key] === '' ? fallback : Number(row.dataset[key]);
  const detailFor = row => {
    const button = row.querySelector('.mc-detail-toggle');
    return button ? document.getElementById(button.getAttribute('aria-controls')) : null;
  };
  const validOption = (select, value) => Array.from(select.options).some(option => option.value === value);
  function restore() {
    const params = new URL(window.location.href).searchParams;
    search.value = (params.get('q') || '').slice(0, 120);
    const requestedGrade = params.get('grade') || '';
    selectedGrade = gradeTabs.some(tab => tab.dataset.mcGrade === requestedGrade) ? requestedGrade : '';
    const requestedShop = params.get('shop') || '';
    shop.value = validOption(shop, requestedShop) ? requestedShop : '';
    const requestedSort = params.get('sort') || 'source';
    sort.value = validOption(sort, requestedSort) ? requestedSort : 'source';
    rated.checked = params.get('rated') === '1';
    monitored.checked = params.get('monitored') === '1';
    const requestedPage = params.get('page') || '1';
    page = /^[1-9]\d{0,5}$/.test(requestedPage) ? Number(requestedPage) : 1;
  }
  function persist() {
    const url = new URL(window.location.href);
    for (const [key, value] of Object.entries({q: search.value, grade: selectedGrade, shop: shop.value, rated: rated.checked ? '1' : '', monitored: monitored.checked ? '1' : '', sort: sort.value === 'source' ? '' : sort.value, page: page > 1 ? String(page) : ''})) {
      if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
    }
    try { window.history.replaceState(null, '', url.href); } catch { /* Local previews may restrict history writes. */ }
  }
  function update(save = true) {
    for (const tab of gradeTabs) tab.setAttribute('aria-pressed', String(tab.dataset.mcGrade === selectedGrade));
    const term = search.value.trim().toLowerCase();
    const ordered = [...rows].sort((a, b) => {
      let diff = 0;
      if (sort.value === 'grade') diff = grades[a.dataset.grade] - grades[b.dataset.grade];
      if (sort.value === 'price') diff = numeric(a, 'price', Infinity) - numeric(b, 'price', Infinity);
      if (sort.value === 'stability') diff = numeric(b, 'stability', -1) - numeric(a, 'stability', -1);
      return diff || Number(a.dataset.rank) - Number(b.dataset.rank);
    });
    const available = ordered.filter(row => row.dataset.search.includes(term)
      && (!shop.value || row.dataset.shop === shop.value)
      && (!rated.checked || ['S', 'A', 'B', 'C'].includes(row.dataset.grade))
      && (!monitored.checked || row.dataset.stability !== ''));
    for (const tab of gradeTabs) {
      const count = tab.querySelector('strong');
      if (count) count.textContent = String(available.filter(row => !tab.dataset.mcGrade || row.dataset.grade === tab.dataset.mcGrade).length);
    }
    const matching = available.filter(row => !selectedGrade || row.dataset.grade === selectedGrade);
    pageCount = Math.max(1, Math.ceil(matching.length / pageSize));
    page = Math.min(page, pageCount);
    const visible = new Set(matching.slice((page - 1) * pageSize, page * pageSize));
    for (const row of ordered) {
      row.hidden = !visible.has(row);
      body.appendChild(row);
      const detail = detailFor(row);
      if (detail) {
        const button = row.querySelector('.mc-detail-toggle');
        detail.hidden = row.hidden || button.getAttribute('aria-expanded') !== 'true';
        body.appendChild(detail);
      }
    }
    reset.disabled = !search.value && !selectedGrade && !shop.value && sort.value === 'source' && page === 1 && !rated.checked && !monitored.checked;
    document.getElementById('mc-count').textContent = `${matching.length} 条线路`;
    document.getElementById('mc-empty').hidden = matching.length !== 0;
    if (pagination) {
      pagination.hidden = matching.length <= pageSize;
      document.getElementById('mc-page-info').textContent = matching.length ? `显示 ${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, matching.length)} / ${matching.length} 条` : '0 条线路';
      document.getElementById('mc-page-number').textContent = `${page} / ${pageCount}`;
      previous.disabled = page === 1;
      next.disabled = page === pageCount;
    }
    if (save) persist();
  }
  function filterChanged() { page = 1; update(); }
  search.addEventListener('input', filterChanged);
  for (const button of gradeTabs) {
    button.addEventListener('click', () => { selectedGrade = button.dataset.mcGrade; filterChanged(); });
  }
  for (const field of [shop, sort, rated, monitored]) field.addEventListener('change', filterChanged);
  reset.addEventListener('click', () => { search.value = ''; selectedGrade = ''; shop.value = ''; sort.value = 'source'; rated.checked = false; monitored.checked = false; filterChanged(); });
  for (const row of rows) {
    const button = row.querySelector('.mc-detail-toggle');
    if (!button) continue;
    button.addEventListener('click', () => {
      const expanded = button.getAttribute('aria-expanded') !== 'true';
      button.setAttribute('aria-expanded', String(expanded));
      button.querySelector('span').textContent = expanded ? '−' : '＋';
      detailFor(row).hidden = !expanded;
    });
  }
  const turnPage = delta => {
    page = Math.max(1, Math.min(pageCount, page + delta)); update();
    document.querySelector('.mc-workbench')?.scrollIntoView?.({block:'start', behavior:'auto'});
  };
  previous?.addEventListener('click', () => turnPage(-1));
  next?.addEventListener('click', () => turnPage(1));
  window.addEventListener('popstate', () => { restore(); update(false); });
  restore(); update(false);
})();
