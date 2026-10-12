// All task mutations run in one service-worker queue. Tokens never enter local history.
importScripts('shared.js');
const TASK_PREFIX = 'f2p-task:';
const TASK_TTL = 5 * 60 * 1000;
const CLAIM_TTL = 30 * 60 * 1000;
let queue = Promise.resolve();
function serial(operation) {
  const result = queue.then(operation);
  queue = result.catch(() => {});
  return result;
}
function isImportSender(sender) {
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.tab?.id || !sender.documentId) return false;
  try {
    const url = new URL(sender.url);
    return url.origin === 'https://github.com' && url.pathname.replace(/\/$/, '') === '/new/import';
  } catch { return false; }
}
function parseImportProgressSender(sender) {
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.tab?.id || !sender.documentId) return null;
  try {
    const url = new URL(sender.url);
    if (url.origin !== 'https://github.com') return null;
    const match = /^\/([^/?#]+)\/([^/?#]+)\/import\/?$/i.exec(url.pathname);
    if (!match) return null;
    const parsed = F2P.parseRepoUrl(`https://github.com/${match[1]}/${match[2]}`);
    return { owner: parsed.owner, repo: parsed.repo, fullRepo: parsed.fullRepo };
  } catch { return null; }
}
function isStartSender(sender) {
  if (sender.id !== chrome.runtime.id) return false;
  if (sender.url === chrome.runtime.getURL('popup.html')) return true;
  if (sender.frameId !== 0 || !sender.tab?.id) return false;
  try { return new URL(sender.url).origin === 'https://github.com'; } catch { return false; }
}
async function historyUpdate(id, patch) {
  const { history = [] } = await chrome.storage.local.get('history');
  await chrome.storage.local.set({ history: history.map(item => item.id === id ? { ...item, ...patch } : item).slice(0, 30) });
}
async function pruneTasks() {
  const entries = await chrome.storage.session.get(null);
  for (const [key, task] of Object.entries(entries)) {
    if (key.startsWith(TASK_PREFIX) && task.expiresAt <= Date.now()) {
      await chrome.storage.session.remove(key);
      if (task.state !== 'submission_requested') await historyUpdate(task.historyId, { status: 'expired' });
    }
  }
}
async function startImport(request, sender) {
  if (!isStartSender(sender)) throw new Error('不允许从此页面发起导入。');
  const source = F2P.parseRepoUrl(request.data?.sourceUrl);
  const targetName = F2P.validateRepoName(request.data?.targetName);
  const { settings } = await chrome.storage.local.get('settings');
  const normalized = F2P.normalizeSettings(settings);
  await pruneTasks();
  const active = Object.keys(await chrome.storage.session.get(null)).filter(key => key.startsWith(TASK_PREFIX));
  if (active.length >= 30) throw new Error('待处理任务较多，请先完成或关闭之前的导入页。');
  const id = crypto.randomUUID();
  const historyId = crypto.randomUUID();
  // Create the tab first, bind its ID, then navigate. A page cannot claim an unbound task.
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false,
    ...(Number.isInteger(sender.tab?.windowId) ? { windowId: sender.tab.windowId } : {}) });
  const automatic = request.data?.mode === 'automatic';
  const task = { id, historyId, sourceUrl: source.cloneUrl, targetName, automatic, autoSubmit: automatic || normalized.autoSubmit,
    baseName: targetName, autoRename: request.data?.autoRename === true, nameAttempt: 1,
    tabId: tab.id, state: 'pending', createdAt: Date.now(), expiresAt: Date.now() + TASK_TTL };
  try {
    await chrome.storage.session.set({ [TASK_PREFIX + id]: task });
    const { history = [] } = await chrome.storage.local.get('history');
    await chrome.storage.local.set({ history: [{ id: historyId, sourceUrl: task.sourceUrl, targetName,
      createdAt: new Date().toISOString(), status: 'pending' }, ...history].slice(0, 30) });
    await chrome.tabs.update(tab.id, { url: `https://github.com/new/import#f2p_task=${id}`, active: true });
    return { success: true, tabId: tab.id };
  } catch (error) {
    await chrome.storage.session.remove(TASK_PREFIX + id);
    await historyUpdate(historyId, { status: 'needs_attention' });
    await chrome.tabs.remove(tab.id).catch(() => {});
    throw error;
  }
}
async function getTask(request, sender) {
  if (!isImportSender(sender) || !/^[0-9a-f-]{36}$/i.test(request.taskId || '')) throw new Error('任务来源不匹配，请从插件重新发起。');
  const key = TASK_PREFIX + request.taskId;
  const task = (await chrome.storage.session.get(key))[key];
  if (!task || task.tabId !== sender.tab.id || task.expiresAt <= Date.now()) throw new Error('任务已失效或不属于这个标签页，请从插件重新发起。');
  return { key, task };
}
async function dispatch(request, sender) {
  if (!request || typeof request.action !== 'string') throw new Error('无效请求。');
  if (request.action === 'START_IMPORT') return startImport(request, sender);
  if (request.action === 'CLEAR_HISTORY') {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) throw new Error('无效来源。');
    await chrome.storage.local.set({ history: [] });
    return { success: true };
  }
  if (request.action === 'GET_SUBMITTED_IMPORT') {
    const progress = parseImportProgressSender(sender);
    if (!progress) return { success: true, task: null };
    await pruneTasks();
    const entries = await chrome.storage.session.get(null);
    for (const [key, item] of Object.entries(entries)) {
      if (!key.startsWith(TASK_PREFIX)) continue;
      if (item.tabId === sender.tab.id && item.state === 'submission_requested' &&
          item.targetName.toLowerCase() === progress.repo.toLowerCase()) {
        return {
          success: true,
          task: {
            id: item.id,
            sourceUrl: item.sourceUrl,
            targetName: item.targetName,
            owner: progress.owner,
            fullRepo: `${progress.owner}/${item.targetName}`,
            repoUrl: `https://github.com/${progress.owner}/${item.targetName}`
          }
        };
      }
    }
    return { success: true, task: null };
  }
  const { key, task } = await getTask(request, sender);
  if (request.action === 'CLAIM_IMPORT') {
    if (task.state !== 'pending') throw new Error('此任务已被使用，请从插件重新发起。');
    await chrome.storage.session.set({ [key]: { ...task, state: 'claimed', documentId: sender.documentId, expiresAt: Date.now() + CLAIM_TTL } });
    await historyUpdate(task.historyId, { status: 'ready' });
    return { success: true, task: { id: task.id, sourceUrl: task.sourceUrl, targetName: task.targetName,
      autoSubmit: task.autoSubmit, autoRename: task.autoRename, automatic: task.automatic } };
  }
  if (request.action === 'NEXT_IMPORT_NAME') {
    if (task.documentId !== sender.documentId || task.state !== 'claimed' || !task.autoRename) throw new Error('当前任务不能自动改名。');
    const attempt = task.nameAttempt + 1;
    if (attempt > 20) throw new Error('已尝试 20 个默认名称，GitHub 仍未确认可用。请检查页面提示或在更多选项中指定名称。');
    const suffix = `-${attempt}`;
    const targetName = F2P.validateRepoName(task.baseName.slice(0, 100 - suffix.length) + suffix);
    await chrome.storage.session.set({ [key]: { ...task, nameAttempt: attempt, targetName } });
    await historyUpdate(task.historyId, { targetName });
    return { success: true, targetName };
  }
  if (request.action === 'IMPORT_STATUS') {
    if (task.documentId !== sender.documentId) throw new Error('页面已更换，请重新发起。');
    const allowed = task.state === 'claimed'
      ? ['submission_requested', 'needs_attention', 'cancelled']
      : task.state === 'submission_requested' ? ['needs_attention'] : [];
    if (!allowed.includes(request.status)) throw new Error('任务状态已变更，请重新发起。');
    await historyUpdate(task.historyId, { status: request.status });
    if (request.status === 'submission_requested') {
      await chrome.storage.session.set({ [key]: { ...task, state: request.status } });
    } else {
      await chrome.storage.session.remove(key);
    }
    return { success: true };
  }
  throw new Error('不支持的操作。');
}
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  serial(() => dispatch(request, sender)).then(sendResponse, error => sendResponse({ success: false, error: error.message || '操作失败，请重试。' }));
  return true;
});
chrome.runtime.onInstalled.addListener(() => {
  serial(async () => {
    const { settings, history = [] } = await chrome.storage.local.get(['settings', 'history']);
    await chrome.storage.local.set({ settings: F2P.normalizeSettings(settings), history: history.map(item => ({
      id: item.id, sourceUrl: item.sourceUrl, targetName: item.targetName, createdAt: item.createdAt,
      status: ['completed', 'importing'].includes(item.status) ? 'legacy_unknown' : item.status
    })).slice(0, 30) });
    await chrome.storage.local.remove('pending_import');
  }).catch(() => {});
});
chrome.tabs.onRemoved.addListener(tabId => {
  serial(async () => {
    const tasks = await chrome.storage.session.get(null);
    for (const [key, task] of Object.entries(tasks)) {
      if (!key.startsWith(TASK_PREFIX) || task.tabId !== tabId) continue;
      if (task.state !== 'submission_requested') await historyUpdate(task.historyId, { status: 'cancelled' });
      await chrome.storage.session.remove(key);
    }
  }).catch(() => {});
});
