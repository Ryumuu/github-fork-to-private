// Content Script for GitHub Repository Pages

(function () {
  "use strict";

  const RESERVED_PATHS = new Set([
    "settings", "explore", "notifications", "orgs", "marketplace",
    "topics", "trending", "collections", "events", "sponsors",
    "account", "new", "login", "signup", "search", "pulls", "issues"
  ]);

  function isImportProgressPath() {
    return /^\/[^/?#]+\/[^/?#]+\/import\/?$/i.test(window.location.pathname);
  }

  function getRepoDetails() {
    if (isImportProgressPath()) return null;
    const pathParts = window.location.pathname.split("/").filter(Boolean);
    if (pathParts.length < 2) return null;

    const owner = pathParts[0];
    const repo = pathParts[1];

    if (RESERVED_PATHS.has(owner.toLowerCase())) return null;
    try { F2P.parseRepoUrl(`https://github.com/${owner}/${repo}`); } catch { return null; }

    // Read GitHub octolytics metadata if available
    const isForkMeta = document.querySelector('meta[name="octolytics-dimension-repository_is_fork"]');
    const parentNwoMeta = document.querySelector('meta[name="octolytics-dimension-repository_parent_nwo"]');
    const userLoginMeta = document.querySelector('meta[name="user-login"]');

    const isFork = isForkMeta ? isForkMeta.content === "true" : false;
    const parentNwo = parentNwoMeta ? parentNwoMeta.content : "";
    const currentUser = userLoginMeta ? userLoginMeta.content : "";

    return {
      owner,
      repo,
      fullRepo: `${owner}/${repo}`,
      cloneUrl: `https://github.com/${owner}/${repo}.git`,
      isFork,
      parentNwo,
      currentUser
    };
  }

  function injectButton() {
    const repoInfo = getRepoDetails();
    if (!repoInfo) return;
    const existingButton = document.getElementById('f2p-private-copy-btn');
    if (existingButton) {
      if (existingButton.dataset.repo !== repoInfo.fullRepo) {
        existingButton.dataset.repo = repoInfo.fullRepo;
        existingButton.disabled = false;
        existingButton.querySelector('.f2p-btn-text').textContent = '复制到私有';
        existingButton.parentElement.querySelector('[role="alert"]').textContent = '';
      }
      return;
    }

    // Locate header actions container
    // Matches GitHub's various container structures
    const container =
      document.querySelector("#repository-details-container ul") ||
      document.querySelector("ul.pagehead-actions") ||
      document.querySelector("div[data-testid='header-actions']") ||
      document.querySelector(".d-flex.gap-2.flex-wrap") ||
      document.querySelector("#fork-button")?.closest("ul, div");

    if (!container) return;

    const btnWrapper = document.createElement("li");
    btnWrapper.id = "f2p-btn-container";
    btnWrapper.className = "d-inline-block";

    const btn = document.createElement("button");
    btn.id = "f2p-private-copy-btn";
    btn.dataset.repo = repoInfo.fullRepo;
    btn.type = "button";
    btn.className = "btn btn-sm f2p-btn";
    btn.title = "一键将此项目复制为完全独立的私有仓库（保留全部历史）";

    btn.innerHTML = `
      <svg class="octicon octicon-lock f2p-lock-icon" viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
        <path d="M4 4a4 4 0 0 1 8 0v2h.25c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 12.25 15h-8.5A1.75 1.75 0 0 1 2 13.25v-5.5C2 6.784 2.784 6 3.75 6H4Zm8.25 3.5h-8.5a.25.25 0 0 0-.25.25v5.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25ZM10.5 6V4a2.5 2.5 0 1 0-5 0v2Z"></path>
      </svg>
      <span class="f2p-btn-text">复制到私有</span>
    `;

    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      const current = getRepoDetails();
      if (!current || btn.disabled) return;
      btn.disabled = true;
      const label = btn.querySelector('.f2p-btn-text');
      label.textContent = '正在启动…';
      error.textContent = '';
      try {
        const settings = F2P.normalizeSettings((await chrome.storage.local.get('settings')).settings);
        const response = await chrome.runtime.sendMessage({ action: 'START_IMPORT', data: {
          sourceUrl: current.cloneUrl, targetName: F2P.defaultTargetName(current.repo, settings.defaultSuffix), autoRename: true, mode: 'automatic'
        } });
        if (!response?.success) throw new Error(response?.error || '无法启动复制，请重新加载扩展后重试。');
        label.textContent = '已开始复制';
      } catch (cause) { error.textContent = cause.message; btn.disabled = false; label.textContent = '复制到私有'; }
    });

    const more = document.createElement('button');
    more.id = 'f2p-more-options'; more.type = 'button'; more.className = 'btn btn-sm';
    more.textContent = '更多选项'; more.title = '自定义名称、选择上游或生成本地复制命令';
    more.addEventListener('click', () => { const current = getRepoDetails(); if (current) showModal(current); });
    const error = document.createElement('span'); error.setAttribute('role', 'alert');
    btnWrapper.append(btn, more, error);

    // Insert near fork button if possible, else append
    const forkBtn = container.querySelector("#fork-button")?.closest("li") || container.lastElementChild;
    if (forkBtn && forkBtn.parentNode === container) {
      container.insertBefore(btnWrapper, forkBtn.nextSibling);
    } else {
      container.appendChild(btnWrapper);
    }
  }

  function showModal(repoInfo) {
    // Remove existing modal if any
    const existing = document.getElementById("f2p-modal-overlay");
    if (existing) existing.remove();

    chrome.storage.local.get(["settings"], (res) => {
      const settings = F2P.normalizeSettings(res.settings);

      const defaultTargetName = F2P.defaultTargetName(repoInfo.repo, settings.defaultSuffix);

      const overlay = document.createElement("div");
      overlay.id = "f2p-modal-overlay";
      overlay.className = "f2p-overlay";

      overlay.innerHTML = `
        <div class="f2p-modal">
          <div class="f2p-modal-header">
            <div class="f2p-title-row">
              <span class="f2p-icon-badge">🔒</span>
              <div class="f2p-title-group">
                <h3 class="f2p-title">复制到独立私有仓库</h3>
                <p class="f2p-subtitle">创建独立私有仓库；Issues、PR 和 LFS 文件需另行迁移</p>
              </div>
            </div>
            <button class="f2p-close-btn" id="f2p-modal-close">&times;</button>
          </div>

          <div class="f2p-modal-body">
            <!-- Source Details -->
            <div class="f2p-field-group">
              <label class="f2p-label">源仓库来源</label>
              <div class="f2p-source-box">
                <span class="f2p-tag ${repoInfo.isFork ? 'f2p-tag-fork' : 'f2p-tag-repo'}">
                  ${repoInfo.isFork ? '已 Fork 仓库' : 'GitHub 仓库'}
                </span>
                <span class="f2p-source-name">${F2P.escapeHtml(repoInfo.fullRepo)}</span>
                ${repoInfo.parentNwo ? `<span class="f2p-source-parent">(源自: ${F2P.escapeHtml(repoInfo.parentNwo)})</span>` : ''}
              </div>
            </div>

            <!-- Target Name Input -->
            <div class="f2p-field-group">
              <label class="f2p-label" for="f2p-target-name">目标私有仓库名称</label>
              <div class="f2p-input-wrapper">
                <span class="f2p-input-prefix">${F2P.escapeHtml(repoInfo.currentUser ? repoInfo.currentUser + '/' : '你的账号/')}</span>
                <input type="text" id="f2p-target-name" class="f2p-input" value="${F2P.escapeHtml(defaultTargetName)}" placeholder="仓库名称" />
              </div>
              <span class="f2p-hint">默认自动添加 <code>${F2P.escapeHtml(settings.defaultSuffix)}</code> 后缀，方便区分并防止同名冲突</span>
            </div>

            <!-- Clone Source Selection (if fork) -->
            ${repoInfo.isFork && repoInfo.parentNwo ? `
            <div class="f2p-field-group">
              <label class="f2p-label">克隆来源</label>
              <div class="f2p-radio-group">
                <label class="f2p-radio-label">
                  <input type="radio" name="f2p-source-choice" value="current" checked />
                  <span>当前 Fork 仓库 (包含你的最新更改)</span>
                </label>
                <label class="f2p-radio-label">
                  <input type="radio" name="f2p-source-choice" value="upstream" />
                  <span>上游原始仓库 (<code>${F2P.escapeHtml(repoInfo.parentNwo)}</code>)</span>
                </label>
              </div>
            </div>
            ` : ''}

            <!-- Mode Tabs -->
            <div class="f2p-tabs">
              <button class="f2p-tab active" data-tab="cloud">🚀 云端免 Token 复制 (推荐)</button>
              <button class="f2p-tab" data-tab="cli">💻 本地双 Remote 终端命令</button>
            </div>

            <!-- Tab 1: Cloud -->
            <div class="f2p-tab-content active" id="f2p-tab-cloud">
              <div class="f2p-feature-list">
                <div class="f2p-feature-item">
                  <span class="f2p-check">✓</span>
                  <span><strong>无需配置 Token</strong>：直接复用你当前已登录的 GitHub 权限</span>
                </div>
                <div class="f2p-feature-item">
                  <span class="f2p-check">✓</span>
                  <span><strong>全自动化云端克隆</strong>：由 GitHub 处理导入，耗时取决于仓库大小和服务状态</span>
                </div>
                <div class="f2p-feature-item">
                  <span class="f2p-check">✓</span>
                  <span><strong>完全私有</strong>：提交前核对 Private；最终结果请以 GitHub 页面为准</span>
                </div>
              </div>
              <div class="f2p-action-row">
                <button type="button" class="f2p-primary-btn" id="f2p-start-cloud-import">
                  立即一键复制到私有仓库
                </button>
              </div>
            </div>

            <!-- Tab 2: CLI -->
            <div class="f2p-tab-content" id="f2p-tab-cli">
              <p class="f2p-hint" style="margin-top:0;">脚本使用 <code>gh</code> 当前登录账号，复制全部 Git 分支和标签，并禁用向 <code>upstream</code> 推送：</p>
              <pre class="f2p-code-block" id="f2p-cli-code"></pre>
              <div class="f2p-action-row">
                <button type="button" class="f2p-secondary-btn" id="f2p-copy-cli">
                  📋 复制完整终端脚本
                </button>
              </div>
            </div>
          </div>
        </div>
      `;

      document.body.appendChild(overlay);

      // Event Handlers
      const closeBtn = overlay.querySelector("#f2p-modal-close");
      closeBtn.addEventListener("click", () => overlay.remove());
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) overlay.remove();
      });

      // Target Name Input listener to update CLI code
      const nameInput = overlay.querySelector("#f2p-target-name");
      const cliBlock = overlay.querySelector("#f2p-cli-code");

      let cliValid = false;
      function chosenSourceUrl() {
        const chosen = overlay.querySelector('input[name="f2p-source-choice"]:checked')?.value;
        return chosen === 'upstream' && repoInfo.parentNwo
          ? `https://github.com/${repoInfo.parentNwo}.git` : repoInfo.cloneUrl;
      }
      function updateCliCode() {
        try {
          cliBlock.textContent = F2P.buildCliScript({ sourceUrl: chosenSourceUrl(), targetName: nameInput.value, localDir: settings.defaultLocalDir });
          cliValid = true;
        } catch (error) {
          cliBlock.textContent = error.message;
          cliValid = false;
        }
      }

      updateCliCode();
      nameInput.addEventListener("input", updateCliCode);
      const radioInputs = overlay.querySelectorAll('input[name="f2p-source-choice"]');
      radioInputs.forEach(r => r.addEventListener("change", updateCliCode));

      // Tab switching
      const tabs = overlay.querySelectorAll(".f2p-tab");
      tabs.forEach(tab => {
        tab.addEventListener("click", () => {
          tabs.forEach(t => t.classList.remove("active"));
          overlay.querySelectorAll(".f2p-tab-content").forEach(c => c.classList.remove("active"));
          tab.classList.add("active");
          const target = overlay.querySelector(`#f2p-tab-${tab.dataset.tab}`);
          if (target) target.classList.add("active");
        });
      });

      // Copy CLI code
      const copyCliBtn = overlay.querySelector("#f2p-copy-cli");
      copyCliBtn.addEventListener('click', async () => {
        if (!cliValid) return;
        try {
          await navigator.clipboard.writeText(cliBlock.textContent);
          copyCliBtn.textContent = '✓ 已复制';
          setTimeout(() => { copyCliBtn.textContent = '📋 复制完整终端脚本'; }, 2500);
        } catch { copyCliBtn.textContent = '复制失败，请手动选择脚本复制'; }
      });

      const startBtn = overlay.querySelector('#f2p-start-cloud-import');
      const errorText = document.createElement('p');
      errorText.className = 'f2p-hint';
      errorText.setAttribute('role', 'alert');
      startBtn.parentElement.appendChild(errorText);
      startBtn.addEventListener('click', async () => {
        startBtn.disabled = true;
        errorText.textContent = '';
        try {
          const source = F2P.parseRepoUrl(chosenSourceUrl());
          const targetName = F2P.validateRepoName(nameInput.value);
          const response = await chrome.runtime.sendMessage({ action: 'START_IMPORT', data: { sourceUrl: source.cloneUrl, targetName, mode: 'automatic',
            autoRename: targetName === defaultTargetName } });
          if (!response?.success) throw new Error(response?.error || '无法启动导入，请重新加载扩展后重试。');
          overlay.remove();
        } catch (error) { errorText.textContent = error.message; startBtn.disabled = false; }
      });
    });
  }

  function isGitHubServerErrorPage() {
    const title = document.title || "";
    const bodyText = document.body ? document.body.textContent || "" : "";
    return /Server Error|\b500\b/i.test(title) ||
      bodyText.includes("Looks like something went wrong!") ||
      bodyText.includes("We track these errors automatically");
  }

  async function isRepoReady(task) {
    if (typeof window.fetch !== "function") return false;
    try {
      const response = await window.fetch(task.repoUrl, { credentials: "same-origin", cache: "no-store" });
      if (!response || !response.ok) return false;
      if (response.url) {
        const finalPath = new URL(response.url, window.location.origin).pathname.replace(/\/$/, "").toLowerCase();
        if (finalPath !== `/${task.fullRepo}`.toLowerCase()) return false;
      }
      const html = await response.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const controller = doc.querySelector('meta[name="route-controller"]')?.getAttribute("content");
      const nwo = doc.querySelector('meta[name="octolytics-dimension-repository_nwo"]')?.getAttribute("content");
      const isPublic = doc.querySelector('meta[name="octolytics-dimension-repository_public"]')?.getAttribute("content");
      return controller === "files" &&
        typeof nwo === "string" && nwo.toLowerCase() === task.fullRepo.toLowerCase() &&
        isPublic === "false";
    } catch {
      return false;
    }
  }

  let importBannerChecked = false;
  async function checkImportErrorBanner() {
    if (importBannerChecked || !isImportProgressPath() || !isGitHubServerErrorPage()) return;
    importBannerChecked = true;
    try {
      const response = await chrome.runtime.sendMessage({ action: "GET_SUBMITTED_IMPORT" });
      const task = response?.success ? response.task : null;
      if (!task || document.getElementById("f2p-import-banner")) return;

      const banner = document.createElement("div");
      banner.id = "f2p-import-banner";
      banner.className = "f2p-banner notranslate";
      banner.setAttribute("translate", "no");
      banner.dataset.version = chrome.runtime.getManifest?.()?.version || "1.1.3";

      const content = document.createElement("div");
      content.className = "f2p-banner-content";

      const left = document.createElement("div");
      const title = document.createElement("div");
      title.className = "f2p-banner-title";
      title.textContent = "已发起私有复制 · 源仓库分支和 PR 记录太多，请耐心等待";

      const desc = document.createElement("div");
      desc.className = "f2p-banner-desc";
      desc.textContent = `GitHub 进度页因分支或 PR 记录过多暂时报错（500），但后台仍在继续复制到私有仓库 ${task.fullRepo}（源自 ${task.sourceUrl}），请勿重复点击。正在自动检测完成状态…`;
      left.append(title, desc);

      const right = document.createElement("div");
      right.className = "f2p-banner-right";

      const statusText = document.createElement("span");
      statusText.className = "f2p-countdown-text";
      statusText.textContent = "后台正在导入，请耐心等待…";

      const openLink = document.createElement("a");
      openLink.className = "f2p-banner-btn";
      openLink.href = task.repoUrl;
      openLink.textContent = `打开私有仓库 (${task.targetName})`;

      right.append(statusText, openLink);
      content.append(left, right);
      banner.append(content);
      document.body.prepend(banner);

      const markReady = () => {
        banner.classList.add("f2p-banner-success");
        title.textContent = "已复制成功！源仓库分支和 PR 记录太多，后台已完成导入";
        desc.textContent = `已确认独立私有仓库 ${task.fullRepo} 代码导入完成（源自 ${task.sourceUrl}），点击右侧按钮即可直接进入仓库。`;
        statusText.textContent = "已确认私有仓库就绪";
        openLink.textContent = `进入私有仓库 (${task.targetName})`;
      };

      if (await isRepoReady(task)) {
        markReady();
        return;
      }

      let attempts = 0;
      const pollTimer = window.setInterval(async () => {
        attempts += 1;
        if (await isRepoReady(task)) {
          window.clearInterval(pollTimer);
          markReady();
        } else if (attempts >= 36) {
          window.clearInterval(pollTimer);
          statusText.textContent = "请点击右侧按钮查看仓库状态";
        }
      }, 5000);
    } catch {
      // Ignore if extension context was invalidated.
    }
  }

  // Initialize and observe GitHub SPA navigation
  function init() {
    injectButton();
    checkImportErrorBanner();

    // GitHub Turbo / PJAX event listeners
    document.addEventListener("turbo:render", injectButton);
    document.addEventListener("turbo:load", injectButton);
    document.addEventListener("pjax:end", injectButton);
    window.addEventListener("popstate", injectButton);

    // MutationObserver fallback for dynamic rendering
    let timeout = null;
    const observer = new MutationObserver(() => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => {
        injectButton();
      }, 300);
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Message listener for popup communication
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "GET_REPO_META") {
      const details = getRepoDetails();
      sendResponse(details);
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
