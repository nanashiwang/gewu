(() => {
  const config = document.getElementById('running-config');
  if (!config) return;
  const {id, descriptions = {}} = JSON.parse(config.textContent);
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) return;
  const el = (id) => document.getElementById(id);
  const headline = el('status-headline'), scoreBox = el('running-score');
  const errorBox = el('run-error'), cancelButton = el('cancel-job');
  const refreshButton = el('refresh-progress'), evidence = el('view-evidence');
  const statusLabels = {pending: '等待执行', running: '执行中', pass: '通过', fail: '未通过', error: '执行错误', skip: '已跳过', interrupted: '未完成'};
  const stages = {queued: '等待检测资源', starting: '准备检测项目', probing: '执行协议与能力检测', measuring: '补充首字延迟观测', summarizing: '整理已完成证据'};
  const terminal = new Set(['done', 'error', 'cancelled', 'interrupted']);
  let stopped = false, disposed = false, navigating = false, failures = 0, timer = null, controller = null;
  let cancelController = null, cancelTimeout = null;
  let pollStarted = Date.now();

  function render(job) {
    if (disposed || (stopped && !terminal.has(job.status))) return;
    const checks = Array.isArray(job.progress?.checks) ? job.progress.checks : [];
    const settled = checks.filter((check) => ['pass', 'fail', 'error', 'skip'].includes(check.status)).length;
    const percent = checks.length ? Math.round(settled / checks.length * 100) : 0;
    el('progress-bar').style.width = percent + '%';
    el('running-meter')?.style.setProperty('--progress', String(percent));
    if (el('progress-count')) el('progress-count').textContent = checks.length ? `${settled}/${checks.length}` : '—';
    if (el('running-passed')) el('running-passed').textContent = String(checks.filter(check => check.status === 'pass').length);
    if (el('running-failed')) el('running-failed').textContent = String(checks.filter(check => check.status === 'fail').length);
    el('progress-track').setAttribute('aria-valuenow', String(percent));
    el('stage-label').textContent = stages[job.progress?.stage] || '整理任务结果';
    const started = job.started_at || job.created_at;
    const end = job.finished_at || Date.now() / 1000;
    el('elapsed-label').textContent = `${job.started_at ? '执行' : '排队'} ${Math.max(0, Math.floor(end - started))} 秒`;
    const valid = checks.filter((check) => ['pass', 'fail'].includes(check.status)).length;
    const errors = checks.filter((check) => check.status === 'error').length;
    const skipped = checks.filter((check) => check.status === 'skip').length;
    el('coverage-label').textContent = checks.length
      ? `${valid} 项取得结果 · ${errors} 项执行错误 · ${skipped} 项跳过 · ${checks.length - settled} 项未完成。完成数量不代表通过率。`
      : '实际检测项目将在任务开始后显示；等待期间不会推算检测进度。';
    const list = el('running-checks');
    list.replaceChildren(...checks.map((check) => {
      const item = document.createElement('li');
      const copy = document.createElement('span'); copy.className = 'check-copy';
      const label = document.createElement('span'); label.className = 'check-label';
      const description = document.createElement('span'); description.className = 'check-description';
      description.textContent = descriptions[check.name] || '按实际执行状态更新，未完成不代表通过。';
      const status = document.createElement('span');
      label.textContent = check.label || check.name;
      status.className = 'running-check-status';
      status.textContent = statusLabels[check.status] || '未确认';
      item.dataset.state = Object.hasOwn(statusLabels, check.status) ? check.status : 'pending';
      copy.append(label, description);
      item.append(copy, status);
      return item;
    }));
    scoreBox.hidden = true;
    if (terminal.has(job.status)) {
      stopped = true;
      clearTimeout(timer);
      el('running-spinner').hidden = true;
      if (cancelButton) cancelButton.hidden = true;
      refreshButton.hidden = true;
      headline.textContent = job.feedback?.title || job.assessment?.headline || '本次检测已结束';
      errorBox.textContent = job.feedback?.message || '请查看本次检测证据。';
      errorBox.hidden = false;
      el('stage-label').textContent = '本次检测已结束';
      if (job.assessment?.score_usable === true && Number.isFinite(job.total_score)) {
        scoreBox.textContent = Math.round(job.total_score) + '/100';
        scoreBox.hidden = false;
      }
      if (job.result_url === '/r/' + id) {
        evidence.hidden = false;
        evidence.textContent = job.assessment?.score_usable ? '查看完整报告' : '查看已完成证据';
        // GET the same job URL once. It now renders the finished report; this
        // neither creates a third confirmation step nor submits a new job.
        if (!navigating) {
          navigating = true;
          location.replace('/r/' + id);
        }
      }
      return;
    }
    headline.textContent = job.status === 'queued' ? '正在排队等待检测' : '正在检测并收集证据';
  }

  async function poll() {
    clearTimeout(timer);
    if (disposed || stopped || document.hidden || controller) return;
    if (Date.now() - pollStarted > 45 * 60 * 1000) {
      refreshButton.hidden = false;
      errorBox.hidden = false;
      errorBox.textContent = '已暂停长时间自动刷新。你可以重新读取进度，此操作不会发起新检测。';
      return;
    }
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 10000);
    try {
      const response = await fetch('/api/status/' + id, {cache: 'no-store', signal: controller.signal});
      if (!response.ok) throw new Error('无法读取任务');
      failures = 0;
      errorBox.hidden = true;
      refreshButton.hidden = true;
      render(await response.json());
    } catch (error) {
      if (!document.hidden && !stopped && ++failures >= 6) {
        headline.textContent = '暂时无法读取进度';
        errorBox.textContent = '任务仍可能在后台运行。请重新读取进度，避免重复提交检测。';
        errorBox.hidden = false;
        refreshButton.hidden = false;
      }
    } finally {
      clearTimeout(timeout);
      controller = null;
      if (!stopped && !document.hidden && failures < 6) timer = setTimeout(poll, 2500);
    }
  }

  refreshButton.addEventListener('click', () => { failures = 0; pollStarted = Date.now(); poll(); });
  cancelButton?.addEventListener('click', async () => {
    cancelButton.disabled = true;
    cancelButton.textContent = '正在停止检测…';
    const control = new AbortController(); cancelController = control;
    cancelTimeout = setTimeout(() => control.abort(), 15000);
    try {
      const response = await fetch('/api/status/' + id + '/cancel', {method: 'POST', signal: control.signal});
      if (!response.ok) throw new Error('未能确认取消结果，请重新读取进度。');
      controller?.abort();
      render(await response.json());
    } catch (error) {
      errorBox.hidden = false;
      errorBox.textContent = '未能确认取消结果，请重新读取进度后再操作。';
      refreshButton.hidden = false;
      cancelButton.disabled = false;
      cancelButton.textContent = '取消本次检测';
    } finally { clearTimeout(cancelTimeout); cancelController = null; cancelTimeout = null; }
  });
  document.addEventListener('visibilitychange', () => {
    clearTimeout(timer);
    if (document.hidden) controller?.abort();
    else if (failures < 6) poll();
  });
  window.addEventListener('pagehide', () => { disposed = true; stopped = true; clearTimeout(timer); controller?.abort(); clearTimeout(cancelTimeout); cancelController?.abort(); });
  window.addEventListener('pageshow', (event) => { if (event.persisted) { disposed = false; stopped = false; navigating = false; poll(); } });
  poll();
})();
