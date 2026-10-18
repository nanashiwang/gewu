(() => {
  const button = document.getElementById('share-btn');
  if (!button) return;
  const stop = document.getElementById('stop-sharing');
  const status = document.getElementById('share-status');
  const fallback = document.getElementById('share-link');
  const job = button.dataset.jobId;
  let active = null;

  async function change(suffix = '') {
    active = new AbortController();
    const timer = setTimeout(() => active?.abort(), 12000);
    try {
      const response = await fetch(`/api/status/${encodeURIComponent(job)}/share${suffix}`, {
        method: 'POST', headers: {'X-Gewu-Action': 'report-sharing'}, signal: active.signal,
      });
      if (!response.ok) throw new Error('sharing failed');
      return await response.json();
    } finally {
      clearTimeout(timer);
      active = null;
    }
  }

  button.addEventListener('click', async () => {
    button.disabled = true;
    if (stop) stop.disabled = true;
    fallback.hidden = true;
    status.textContent = job ? '正在准备分享链接…' : '正在复制链接…';
    try {
      const data = job ? await change() : {url: location.pathname};
      const link = new URL(data.url, location.origin);
      if (link.origin !== location.origin) throw new Error('unexpected share URL');
      if (stop) stop.hidden = false;
      if (job) button.textContent = '复制分享链接';
      try {
        await navigator.clipboard.writeText(link.href);
        status.textContent = job ? '链接已复制，可以直接发给别人。' : '历史公开报告链接已复制。';
      } catch (_) {
        // Clipboard access may be unavailable or lose user activation during
        // the request (notably Safari). Keep an ordinary, selectable fallback.
        fallback.value = link.href;
        fallback.hidden = false;
        fallback.focus();
        fallback.select();
        status.textContent = '链接已准备好，请复制下方链接。';
      }
    } catch (_) {
      status.textContent = '未能确认分享状态，请再点一次；重复点击不会重新检测。';
    } finally {
      button.disabled = false;
      if (stop) stop.disabled = false;
    }
  });

  stop?.addEventListener('click', async () => {
    button.disabled = stop.disabled = true;
    try {
      await change('/revoke');
      stop.hidden = true;
      fallback.hidden = true;
      fallback.value = '';
      button.textContent = '分享摘要';
      status.textContent = '分享已关闭，旧链接不再可用。已被保存的内容无法收回。';
    } catch (_) {
      status.textContent = '未能确认分享已关闭，请重试；不要假定旧链接已经失效。';
    } finally { button.disabled = stop.disabled = false; }
  });
  window.addEventListener('pagehide', () => active?.abort());
})();
