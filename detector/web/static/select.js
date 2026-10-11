// Enhance native selects; only existing options can become form values.
(() => {
  let opened = null;
  document.querySelectorAll('select[data-picker]').forEach(select => {
    const searchable = select.dataset.picker === 'search';
    const label = select.labels?.[0];
    const name = label?.textContent.trim() || '选项';
    const make = (tag, className) => Object.assign(document.createElement(tag), {className});
    const root = make('div', 'select-picker');
    select.before(root);
    root.append(select);
    const trigger = make('button', 'select-trigger');
    trigger.type = 'button';
    trigger.id = `${select.id}-trigger`;
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', `${select.id}-listbox`);
    if (!searchable) trigger.setAttribute('role', 'combobox');
    if (select.getAttribute('aria-describedby')) trigger.setAttribute('aria-describedby', select.getAttribute('aria-describedby'));
    const value = make('span', 'select-value');
    value.id = `${select.id}-value`;
    const chevron = make('span', 'select-chevron');
    chevron.setAttribute('aria-hidden', 'true');
    trigger.append(value, chevron);
    if (label) {
      if (!label.id) label.id = `${select.id}-label`;
      trigger.setAttribute('aria-labelledby', `${label.id} ${value.id}`);
      label.htmlFor = trigger.id;
    } else trigger.setAttribute('aria-label', name);
    const panel = make('div', 'select-panel');
    panel.hidden = true;
    let search;
    if (searchable) {
      search = make('input', 'select-search');
      Object.assign(search, {type: 'search', placeholder: `搜索${name}`, autocomplete: 'off', spellcheck: false});
      search.setAttribute('aria-label', `搜索${name}`);
      search.setAttribute('role', 'combobox');
      search.setAttribute('aria-autocomplete', 'list');
      search.setAttribute('aria-expanded', 'true');
      search.setAttribute('aria-controls', `${select.id}-listbox`);
      panel.append(search);
    }
    const list = make('div', 'select-options');
    list.id = `${select.id}-listbox`;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', name);
    const empty = make('p', 'select-empty');
    empty.setAttribute('role', 'status');
    empty.textContent = '没有匹配的选项，换个关键词试试。';
    const error = make('p', 'select-error');
    error.id = `${select.id}-error`;
    error.textContent = `请选择${name}`;
    error.hidden = true;
    panel.append(list, empty);
    root.append(trigger, panel, error);
    let items = [], active = -1, open = false;
    function position() {
      if (!open) return;
      const rect = trigger.getBoundingClientRect(), viewport = window.visualViewport;
      const viewportTop = viewport?.offsetTop || 0;
      const bottom = viewportTop + (viewport?.height || innerHeight);
      const top = Math.max(viewportTop, document.querySelector('.site-header')?.getBoundingClientRect().bottom || 0);
      if (rect.bottom <= top || rect.top >= bottom) { close(); return; }
      const below = Math.max(0, bottom - rect.bottom - 16), above = Math.max(0, rect.top - top - 16);
      // Filtering must not flip a focused search box to the other side of the trigger.
      const count = Array.from(select.options).filter(option => !option.disabled).length;
      const desired = Math.min(352, Math.max(count, 2) * 44 + (searchable ? 60 : 14));
      const upwards = below < desired && above > below;
      panel.dataset.placement = upwards ? 'above' : 'below';
      panel.style.height = `${Math.min(desired, upwards ? above : below)}px`;
    }
    function highlight(index, scroll = true) {
      active = items.length ? Math.max(0, Math.min(index, items.length - 1)) : -1;
      Array.from(list.children).forEach((item, i) => item.classList.toggle('is-active', i === active));
      const controller = search || trigger;
      if (active < 0) controller.removeAttribute('aria-activedescendant');
      else {
        controller.setAttribute('aria-activedescendant', list.children[active].id);
        if (scroll) {
          const itemRect = list.children[active].getBoundingClientRect();
          const listRect = list.getBoundingClientRect();
          if (itemRect.top < listRect.top) list.scrollTop -= listRect.top - itemRect.top;
          else if (itemRect.bottom > listRect.bottom) list.scrollTop += itemRect.bottom - listRect.bottom;
        }
      }
    }
    function render() {
      const query = search?.value.trim().toLowerCase() || '';
      items = Array.from(select.options).filter(option => !option.disabled && (!query || option.textContent.toLowerCase().includes(query)));
      list.replaceChildren();
      items.forEach((option, index) => {
        const item = make('div', 'select-option');
        item.id = `${select.id}-option-${index}`;
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(option.value === select.value));
        const text = document.createElement('span');
        text.textContent = option.textContent;
        const tick = make('span', 'select-tick');
        tick.setAttribute('aria-hidden', 'true');
        tick.textContent = '✓';
        item.append(text, tick);
        item.addEventListener('pointerdown', event => event.preventDefault());
        item.addEventListener('click', () => choose(index));
        list.append(item);
      });
      empty.hidden = items.length > 0;
      list.hidden = items.length === 0;
      position();
      highlight(Math.max(0, items.findIndex(option => option.value === select.value)), false);
    }
    function sync() {
      value.textContent = select.selectedOptions[0]?.textContent || `请选择${name}`;
      trigger.classList.toggle('is-placeholder', !select.value);
      trigger.disabled = select.disabled;
      if (select.validity.valid) {
        trigger.removeAttribute('aria-invalid'); error.hidden = true;
        const hint = select.getAttribute('aria-describedby');
        if (hint) trigger.setAttribute('aria-describedby', hint);
        else trigger.removeAttribute('aria-describedby');
      }
      if (open) render();
    }
    function close(restoreFocus = false) {
      open = false;
      panel.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      trigger.removeAttribute('aria-activedescendant');
      if (opened === control) opened = null;
      if (restoreFocus) trigger.focus({preventScroll: true});
    }
    function show() {
      if (select.disabled) return;
      if (opened && opened !== control) opened.close();
      opened = control;
      if (search) search.value = '';
      open = true;
      panel.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      render();
      (search || trigger).focus({preventScroll: true});
      highlight(active);
    }
    function choose(index) {
      if (!items[index]) return;
      select.value = items[index].value;
      select.dispatchEvent(new Event('input', {bubbles: true}));
      select.dispatchEvent(new Event('change', {bubbles: true}));
      sync();
      close(true);
    }
    const control = {close, position};
    trigger.addEventListener('click', () => open ? close(true) : show());
    root.addEventListener('keydown', event => {
      if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(true); }
      else if (event.key === 'Tab') close();
      else if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault();
        if (!open) show(); else highlight(active + (event.key === 'ArrowDown' ? 1 : -1));
      } else if (open && (event.key === 'Enter' || (!searchable && event.key === ' '))) {
        event.preventDefault(); choose(active);
      } else if (open && ['Home', 'End'].includes(event.key) && event.target !== search) {
        event.preventDefault(); highlight(event.key === 'Home' ? 0 : items.length - 1);
      }
    });
    search?.addEventListener('input', render);
    select.addEventListener('change', sync);
    select.addEventListener('focus', () => trigger.focus());
    select.addEventListener('invalid', event => {
      event.preventDefault();
      trigger.setAttribute('aria-invalid', 'true');
      error.hidden = false;
      trigger.setAttribute('aria-describedby', [select.getAttribute('aria-describedby'), error.id].filter(Boolean).join(' '));
      trigger.focus();
    });
    select.form?.addEventListener('reset', () => queueMicrotask(() => { close(); sync(); }));
    document.addEventListener('pointerdown', event => { if (open && !root.contains(event.target)) close(); });
    root.addEventListener('focusout', event => { if (open && event.relatedTarget && !root.contains(event.relatedTarget)) close(); });
    new MutationObserver(sync).observe(select, {childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'selected', 'label']});
    // Hide only after construction: without JS the native control still works.
    select.classList.add('select-native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    sync();
  });
  window.addEventListener('resize', () => opened?.position());
  window.addEventListener('scroll', () => opened?.position(), true);
  window.visualViewport?.addEventListener('resize', () => opened?.position());
})();
