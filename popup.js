document.addEventListener('DOMContentLoaded', async () => {
  const byId = id => document.getElementById(id);
  let settings = F2P.normalizeSettings();
  let currentRepo;
  let toastTimer;
  const toast = text => {
    byId('toast-msg').textContent = text; byId('toast-msg').style.display = 'block';
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { byId('toast-msg').style.display = 'none'; }, 4500);
  };
  async function send(action, data) {
    const response = await chrome.runtime.sendMessage({ action, data });
    if (!response?.success) throw new Error(response?.error || '操作未完成，请重新加载扩展再试。');
    return response;
  }
  function onButton(id, action) {
    byId(id).addEventListener('click', async () => {
      const button = byId(id); button.disabled = true;
      try { await action(); } catch (error) { toast(error.message || '操作失败，请重试。'); }
      finally { button.disabled = false; }
    });
  }
  const statuses = { pending: '等待打开导入页', ready: '待提交', submission_requested: '已发起提交，结果待确认',
    needs_attention: '需要检查', expired: '已过期，请重新发起', cancelled: '已取消', legacy_unknown: '旧版记录，结果未核实' };
  async function renderHistory() {
    const { history = [] } = await chrome.storage.local.get('history');
    const container = byId('history-container'); container.replaceChildren();
    byId('history-empty').style.display = history.length ? 'none' : 'block';
    byId('btn-clear-history').style.display = history.length ? 'block' : 'none';
    for (const item of history) {
      const row = document.createElement('div'); row.className = 'history-item';
      const header = document.createElement('div'); header.className = 'history-item-header';
      const name = document.createElement('span'); name.className = 'history-name'; name.textContent = item.targetName || '未命名';
      const date = document.createElement('span'); date.className = 'history-date';
      const parsed = new Date(item.createdAt); date.textContent = Number.isNaN(parsed.getTime()) ? String(item.createdAt || '') : parsed.toLocaleString();
      header.append(name, date);
      const source = document.createElement('div'); source.className = 'history-sub'; source.textContent = item.sourceUrl || '';
      const status = document.createElement('div'); status.className = 'history-sub'; status.textContent = statuses[item.status] || '结果未核实';
      row.append(header, source, status); container.append(row);
    }
  }
  for (const button of document.querySelectorAll('.nav-tab')) button.addEventListener('click', () => {
    document.querySelectorAll('.nav-tab').forEach(el => el.classList.toggle('active', el === button));
    document.querySelectorAll('.tab-pane').forEach(el => el.classList.toggle('active', el.id === button.dataset.target));
    if (button.dataset.target === 'tab-history') renderHistory().catch(error => toast(error.message));
  });
  onButton('btn-cloud-import', async () => {
    if (!currentRepo) throw new Error('请先打开 GitHub 仓库页面。');
    const targetName = F2P.validateRepoName(byId('target-repo-name').value);
    await send('START_IMPORT', { sourceUrl: currentRepo.cloneUrl, targetName, mode: 'automatic',
      autoRename: targetName === F2P.defaultTargetName(currentRepo.repo, settings.defaultSuffix) });
    window.close();
  });
  onButton('btn-copy-cli', async () => {
    if (!currentRepo) throw new Error('请先打开 GitHub 仓库页面。');
    await navigator.clipboard.writeText(F2P.buildCliScript({ sourceUrl: currentRepo.cloneUrl,
      targetName: byId('target-repo-name').value, localDir: settings.defaultLocalDir }));
    toast('已复制。脚本使用 gh 当前登录的 GitHub 账号。');
  });
  byId('manual-source-url').addEventListener('input', () => {
    try { const source = F2P.parseRepoUrl(byId('manual-source-url').value); byId('manual-target-name').value = F2P.defaultTargetName(source.repo, settings.defaultSuffix); } catch { /* An incomplete URL is normal while typing. */ }
  });
  onButton('btn-manual-import', async () => {
    const source = F2P.parseRepoUrl(byId('manual-source-url').value);
    await send('START_IMPORT', { sourceUrl: source.cloneUrl, targetName: F2P.validateRepoName(byId('manual-target-name').value) });
    window.close();
  });
  onButton('btn-clear-history', async () => { await send('CLEAR_HISTORY'); await renderHistory(); toast('历史记录已清空。'); });
  onButton('btn-save-settings', async () => {
    const suffix = byId('setting-suffix').value.trim() || '-private';
    F2P.validateRepoName('repo' + suffix);
    const localDir = byId('setting-local-dir').value.trim() || '~/Projects';
    // Use the same validation as the generator; do not silently change an unsafe path.
    F2P.buildCliScript({ sourceUrl: 'https://github.com/example/repo.git', targetName: 'repo' + suffix, localDir });
    settings = F2P.normalizeSettings({ defaultSuffix: suffix, defaultLocalDir: localDir, autoSubmit: byId('setting-auto-submit').checked });
    await chrome.storage.local.set({ settings }); toast('设置已保存。');
  });
  function showNoRepo() { byId('current-repo-view').style.display = 'none'; byId('no-repo-view').style.display = 'block'; }
  try {
    settings = F2P.normalizeSettings((await chrome.storage.local.get('settings')).settings);
    byId('setting-suffix').value = settings.defaultSuffix; byId('setting-local-dir').value = settings.defaultLocalDir;
    byId('setting-auto-submit').checked = settings.autoSubmit;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return showNoRepo();
    const url = new URL(tab.url); const parts = url.pathname.split('/').filter(Boolean);
    const reserved = new Set(['settings','explore','notifications','orgs','marketplace','topics','trending','collections','events','sponsors','account','new','login','signup','search','pulls','issues','users','organizations','features']);
    if (url.origin !== 'https://github.com' || parts.length < 2 || reserved.has(parts[0].toLowerCase()) ||
        (parts.length === 3 && parts[2].toLowerCase() === 'import')) return showNoRepo();
    currentRepo = F2P.parseRepoUrl(`https://github.com/${parts[0]}/${parts[1]}`);
    byId('current-repo-name').textContent = currentRepo.fullRepo;
    byId('target-repo-name').value = F2P.defaultTargetName(currentRepo.repo, settings.defaultSuffix);
    byId('current-repo-sub').textContent = 'GitHub 仓库；导入结果请以 GitHub 页面为准';
    byId('current-repo-view').style.display = 'block'; byId('no-repo-view').style.display = 'none';
    try {
      const meta = await chrome.tabs.sendMessage(tab.id, { action: 'GET_REPO_META' });
      byId('current-repo-fork-badge').style.display = meta?.isFork ? 'inline-block' : 'none';
      if (meta?.isFork) byId('current-repo-sub').textContent = `上游源：${meta.parentNwo || '未知'}`;
    } catch { /* A newly installed extension may need the GitHub tab refreshed. URL detection still works. */ }
  } catch (error) { showNoRepo(); toast(error.message); }
});
