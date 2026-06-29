const stateRef = {
  state: null,
  permissions: null,
  permissionPollTimer: null,
  pendingSetupGuide: false,
  setupGuideStep: 0,
  updateInfo: null
};
const SETUP_STEP_COUNT = 5;
const expandedProjectIds = new Set();
const PERMISSION_LABELS = {
  granted: '已授权',
  missing: '未授权',
  denied: '未授权',
  restricted: '受限制',
  notDetermined: '未授权',
  unknown: '未知'
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('show');
  setTimeout(() => node.classList.remove('show'), 2600);
}

async function runAction(action, successMessage) {
  try {
    const result = await action();
    if (successMessage) toast(successMessage);
    await refreshState();
    return result;
  } catch (error) {
    toast(error.message || String(error));
    throw error;
  }
}

function setView(viewId) {
  $$('.nav-item').forEach((node) => node.classList.toggle('active', node.dataset.view === viewId));
  $$('.view').forEach((node) => node.classList.toggle('active', node.id === viewId));
}

function getSettingsForm() {
  return {
    appId: $('#appId').value.trim(),
    appSecret: $('#appSecret').value.trim(),
    defaultChatId: $('#defaultChatId').value.trim(),
    allowedSenderIds: $('#allowedSenderIds').value.trim(),
    triggerKeywords: $('#triggerKeywords').value.trim(),
    codexBin: $('#codexBin').value.trim() || 'codex',
    model: $('#model').value.trim() || 'gpt-5.4',
    deliveryMode: $('#deliveryMode').value,
    summaryIntervalMs: Number($('#summaryIntervalMs').value || 20000),
    noResponseAlertMs: Number($('#noResponseAlertMs').value || 300000),
    launchAtLogin: $('#launchAtLogin').checked,
    autoStart: $('#autoStart').checked,
    mirrorExistingThread: $('#mirrorExistingThread').checked,
    openCodexThreadOnMessage: $('#openCodexThreadOnMessage').checked,
    restoreClipboardAfterPaste: $('#restoreClipboardAfterPaste').checked
  };
}

function fillSettings(state) {
  $('#appId').value = state.settings.appId || '';
  $('#appSecret').placeholder = state.settings.hasAppSecret ? '已保存，留空保持不变' : '请输入 App Secret';
  $('#defaultChatId').value = state.settings.defaultChatId || '';
  $('#allowedSenderIds').value = state.settings.allowedSenderIds || '';
  $('#triggerKeywords').value = state.settings.triggerKeywords || '';
  $('#codexBin').value = state.settings.codexBin || 'codex';
  $('#model').value = state.settings.model || 'gpt-5.4';
  $('#deliveryMode').value = state.settings.deliveryMode || 'appServer';
  $('#summaryIntervalMs').value = state.settings.summaryIntervalMs || 20000;
  $('#noResponseAlertMs').value = state.settings.noResponseAlertMs || 300000;
  $('#launchAtLogin').checked = Boolean(state.settings.launchAtLogin);
  $('#autoStart').checked = Boolean(state.settings.autoStart);
  $('#mirrorExistingThread').checked = state.settings.mirrorExistingThread !== false;
  $('#openCodexThreadOnMessage').checked = state.settings.openCodexThreadOnMessage !== false;
  $('#restoreClipboardAfterPaste').checked = state.settings.restoreClipboardAfterPaste !== false;
}

function renderState(state) {
  stateRef.state = state;
  fillSettings(state);

  const running = state.runtime.bridgeRunning;
  const feishuStatus = serviceStatusLabel(state.runtime.feishuStatus, 'feishu');
  const codexStatus = serviceStatusLabel(state.runtime.codexStatus, 'codex');
  const watcherStatus = state.runtime.watcherStatus || {};
  const watcherLabel = `${watcherStatus.foundCount || 0}/${watcherStatus.watchedCount || 0}`;
  $('#bridgeDot').className = `dot ${running ? 'running' : state.runtime.lastError ? 'error' : ''}`;
  $('#bridgeLabel').textContent = state.runtime.lastError ? '异常' : running ? '运行中' : '未启动';
  $('#bridgeSubLabel').textContent = state.runtime.lastError
    ? '见日志'
    : `${shortStatus(state.runtime.feishuStatus, '飞书')} · 线程 ${watcherLabel}`;
  const appVersion = state.appVersion ? `v${state.appVersion}` : 'v-';
  $('#appVersionBadge').textContent = appVersion;
  $('#releaseNotesVersion').textContent = appVersion;
  $('#feishuMetric').className = `metric metric-status ${statusTone(state.runtime.feishuStatus)}`;
  $('#codexMetric').className = `metric metric-status ${statusTone(state.runtime.codexStatus)}`;
  $('#projectMetric').className = `metric metric-status project-metric ${state.projects.length ? 'running' : ''}`;
  $('#feishuStatus').textContent = feishuStatus;
  $('#codexStatus').textContent = codexStatus;
  $('#projectCount').textContent = state.projects.length;

  renderProjects('#dashboardProjects', state.projects.slice(0, 4), { compact: true });
  renderProjects('#projectList', state.projects, { compact: false });
  renderChatBindings(state);
  renderLogs(state.events || []);
  renderUpdateInfo(stateRef.updateInfo);
}

function renderUpdateInfo(info) {
  const button = $('#updateAvailableButton');
  if (!button) return;

  const hasUpdate = Boolean(info?.hasUpdate);
  button.hidden = !hasUpdate;
  if (hasUpdate) {
    button.textContent = info.latestVersion ? `更新 v${info.latestVersion}` : '有更新';
  }
}

function permissionLabel(permission) {
  if (permission?.granted) return '已授权';
  return PERMISSION_LABELS[permission?.status] || '未授权';
}

function setPermissionItem(key, permission) {
  const item = $(`.permission-item[data-permission="${key}"]`);
  if (!item) return;

  const granted = Boolean(permission?.granted);
  item.classList.toggle('granted', granted);
  item.classList.toggle('missing', !granted);
  item.querySelector('.permission-state strong').textContent = permissionLabel(permission);
  item.querySelector('.permission-open').hidden = granted;
}

function renderPermissionModal(status) {
  stateRef.permissions = status;
  setPermissionItem('accessibility', status?.accessibility);
  setPermissionItem('screen', status?.screen);
  $('#permissionDone').textContent = status?.allGranted ? '完成' : '稍后处理';
}

function showPermissionModal() {
  const modal = $('#permissionModal');
  modal.hidden = false;
  requestAnimationFrame(() => modal.classList.add('show'));
}

function hidePermissionModal() {
  const modal = $('#permissionModal');
  modal.classList.remove('show');
  setTimeout(() => {
    if (!modal.classList.contains('show')) {
      modal.hidden = true;
    }
  }, 160);
}

function startPermissionPolling() {
  if (stateRef.permissionPollTimer) return;
  stateRef.permissionPollTimer = setInterval(() => {
    refreshPermissions({ showIfNeeded: false }).catch(() => {});
  }, 2200);
}

function stopPermissionPolling() {
  if (!stateRef.permissionPollTimer) return;
  clearInterval(stateRef.permissionPollTimer);
  stateRef.permissionPollTimer = null;
}

async function refreshPermissions({ showIfNeeded = false } = {}) {
  if (!window.bridgeApi.getPermissions) return null;
  const status = await window.bridgeApi.getPermissions();
  renderPermissionModal(status);

  if (!status?.supported) return status;
  if (showIfNeeded && (!status.guideSeen || !status.allGranted)) {
    showPermissionModal();
    if (!status.allGranted) startPermissionPolling();
  }
  if (status.allGranted) stopPermissionPolling();
  return status;
}

async function closePermissionGuide() {
  if (window.bridgeApi.markPermissionGuideSeen) {
    const status = await window.bridgeApi.markPermissionGuideSeen();
    renderPermissionModal(status);
  }
  stopPermissionPolling();
  hidePermissionModal();
  if (stateRef.pendingSetupGuide) {
    stateRef.pendingSetupGuide = false;
    setTimeout(() => showSetupGuide(0), 180);
  }
}

function shouldShowSetupGuide() {
  const settings = stateRef.state?.settings || {};
  return settings.setupGuideCompleted !== true;
}

function setupHasSavedSecret() {
  return Boolean(stateRef.state?.settings?.hasAppSecret);
}

function fillSetupFields() {
  const settings = stateRef.state?.settings || {};
  $('#setupAppId').value = settings.appId || $('#appId')?.value || '';
  $('#setupAppSecret').value = '';
  $('#setupAppSecret').placeholder = setupHasSavedSecret() ? '已保存，留空保持不变' : '请输入 App Secret';
  $('#setupTriggerKeywords').value = settings.triggerKeywords || '';
}

function setSetupStep(step) {
  const nextStep = Math.min(Math.max(Number(step) || 0, 0), SETUP_STEP_COUNT - 1);
  stateRef.setupGuideStep = nextStep;
  $$('.setup-step').forEach((node) => {
    const active = Number(node.dataset.step) === nextStep;
    const done = Number(node.dataset.step) < nextStep;
    node.classList.toggle('active', active);
    node.classList.toggle('done', done);
  });
  $$('.setup-panel').forEach((node) => {
    node.classList.toggle('active', Number(node.dataset.step) === nextStep);
  });
  $('#setupBack').disabled = nextStep === 0;
  $('#setupNext').textContent = nextStep === SETUP_STEP_COUNT - 1 ? '完成并进入软件' : '下一步';
  $('#setupProgress').textContent = `第 ${nextStep + 1} 步，共 ${SETUP_STEP_COUNT} 步`;
}

function showSetupGuide(step = 0) {
  fillSetupFields();
  setSetupStep(step);
  const modal = $('#setupModal');
  modal.hidden = false;
  requestAnimationFrame(() => modal.classList.add('show'));
}

function hideSetupGuide() {
  const modal = $('#setupModal');
  modal.classList.remove('show');
  setTimeout(() => {
    if (!modal.classList.contains('show')) {
      modal.hidden = true;
    }
  }, 160);
}

function showReleaseNotes() {
  const modal = $('#releaseNotesModal');
  if (!modal) return;
  modal.hidden = false;
  modal.classList.add('show');
}

window.showReleaseNotesFromBadge = showReleaseNotes;

function hideReleaseNotes() {
  const modal = $('#releaseNotesModal');
  modal.classList.remove('show');
  setTimeout(() => {
    if (!modal.classList.contains('show')) {
      modal.hidden = true;
    }
  }, 160);
}

async function saveSetupStep() {
  const patch = {};
  const appId = $('#setupAppId').value.trim();
  const appSecret = $('#setupAppSecret').value.trim();
  const triggerKeywords = $('#setupTriggerKeywords').value.trim();

  if (stateRef.setupGuideStep === 0) {
    if (!appId) throw new Error('请填写飞书 App ID');
    if (!appSecret && !setupHasSavedSecret()) throw new Error('请填写飞书 App Secret');
    patch.appId = appId;
    if (appSecret) patch.appSecret = appSecret;
  }

  if (stateRef.setupGuideStep === 2) {
    patch.triggerKeywords = triggerKeywords;
  }

  if (Object.keys(patch).length) {
    await window.bridgeApi.saveSettings(patch);
    await refreshState();
  }
}

async function completeSetupGuide() {
  await saveSetupStep();
  if (window.bridgeApi.completeSetupGuide) {
    await window.bridgeApi.completeSetupGuide();
    await refreshState();
  }
  hideSetupGuide();
  setView('dashboard');
  toast('首次配置向导已完成');
}

async function skipSetupGuide() {
  if (window.bridgeApi.completeSetupGuide) {
    await window.bridgeApi.completeSetupGuide();
    await refreshState();
  }
  hideSetupGuide();
  toast('以后可在飞书配置里重新打开向导');
}

async function startInitialGuides() {
  await refreshState();
  const permissions = await refreshPermissions();
  const needsPermissionGuide = Boolean(permissions?.supported && (!permissions.guideSeen || !permissions.allGranted));
  const needsSetupGuide = shouldShowSetupGuide();

  if (needsPermissionGuide) {
    stateRef.pendingSetupGuide = needsSetupGuide;
    showPermissionModal();
    if (!permissions.allGranted) startPermissionPolling();
    return;
  }

  if (needsSetupGuide) {
    showSetupGuide(0);
  }
}

async function checkAppUpdates({ quiet = true } = {}) {
  if (!window.bridgeApi.checkForUpdates) return null;
  try {
    const info = await window.bridgeApi.checkForUpdates();
    stateRef.updateInfo = info;
    renderUpdateInfo(info);
    if (!quiet && info?.hasUpdate) {
      toast(`发现新版本 v${info.latestVersion}`);
    } else if (!quiet && !info?.hasUpdate) {
      toast('当前已经是最新版本');
    }
    return info;
  } catch (error) {
    if (!quiet) toast(error.message || String(error));
    return null;
  }
}

function shortStatus(status, label) {
  if (status === 'running' || status === 'ready' || status === 'not-required') return `${label}正常`;
  if (status === 'failed') return `${label}异常`;
  if (status === 'starting') return `${label}启动中`;
  if (status === 'stopping') return `${label}停止中`;
  return `${label}未启`;
}

function serviceStatusLabel(status, service) {
  if (service === 'codex' && status === 'not-required') return '界面投递已就绪';
  const labels = {
    running: '运行中',
    stopped: '未启动',
    failed: '异常',
    starting: '启动中',
    stopping: '停止中',
    idle: '空闲',
    ready: '已就绪',
    unknown: '未知'
  };
  return labels[status] || labels.unknown;
}

function statusTone(status) {
  if (status === 'running' || status === 'not-required' || status === 'ready') return 'running';
  if (status === 'failed') return 'failed';
  if (status === 'starting' || status === 'stopping') return 'pending';
  return '';
}

function statusClass(status) {
  if (status === 'running') return 'running';
  if (status === 'failed') return 'failed';
  return '';
}

function projectStatusLabel(status) {
  const labels = {
    running: '运行中',
    failed: '异常',
    idle: '空闲',
    queued: '排队中',
    stopped: '未启动'
  };
  return labels[status] || '空闲';
}

function renderProjects(selector, projects, { compact }) {
  const root = $(selector);
  if (!projects.length) {
    root.className = 'project-list empty';
    root.textContent = '还没有项目。';
    return;
  }

  if (!compact) {
    const currentIds = new Set(projects.map((project) => project.id));
    for (const projectId of Array.from(expandedProjectIds)) {
      if (!currentIds.has(projectId)) expandedProjectIds.delete(projectId);
    }
  }

  root.className = 'project-list';
  root.innerHTML = projects.map((project) => {
    const expanded = expandedProjectIds.has(project.id);
    const collapsibleClass = ' project-collapsible';
    const expandedClass = expanded ? ' expanded' : ' collapsed';
    const bodyHidden = !expanded ? ' hidden' : '';
    const head = `
      <button type="button" class="project-toggle" aria-expanded="${String(expanded)}">
        <span class="project-chevron" aria-hidden="true">›</span>
        <span class="project-title-block">
          <span class="project-title">${escapeHtml(project.alias)}</span>
          <span class="status-pill ${statusClass(project.status)}">${escapeHtml(projectStatusLabel(project.status))}</span>
        </span>
      </button>
    `;

    return `
      <article class="project-card${collapsibleClass}${expandedClass}" data-project-id="${project.id}">
        <div class="project-head">
          ${head}
          ${compact ? '' : `<button class="danger remove-project">删除</button>`}
        </div>
        <div class="project-body"${bodyHidden}>
          <div class="project-meta">
            <div>目录：<code>${escapeHtml(project.cwd || '-')}</code></div>
            <div>线程：<code>${escapeHtml(project.threadId || '未创建')}</code></div>
            <div>飞书：<code>${escapeHtml(project.chatId || '默认 Chat ID')}</code></div>
            <div>队列：<code>${escapeHtml((project.taskQueue || []).length)} 条</code></div>
          </div>
          ${project.lastSummary ? `<pre>${escapeHtml(project.lastSummary)}</pre>` : ''}
          ${compact ? '' : `
            <textarea class="prompt-box" placeholder="给这个项目发送一条 Codex 指令"></textarea>
            <div class="project-actions">
              <button class="send-prompt primary">发送到 Codex</button>
              <button class="send-status">推送状态到飞书</button>
            </div>
          `}
        </div>
      </article>
    `;
  }).join('');
}

function renderLogs(events) {
  const root = $('#logsList');
  if (!events.length) {
    root.className = 'logs empty';
    root.textContent = '暂无日志。';
    return;
  }

  root.className = 'logs';
  root.innerHTML = events.slice().reverse().map((event) => `
    <div class="log-entry">
      <small>${escapeHtml(new Date(event.at).toLocaleString())}</small>
      <strong>${escapeHtml(event.type)}</strong>
      <span>${escapeHtml(event.message)}</span>
    </div>
  `).join('');
}

function renderChatBindings(state) {
  const select = $('#bindingProjectId');
  const list = $('#chatBindingList');
  if (!select || !list) return;

  if (!state.projects.length) {
    select.innerHTML = '<option value="">先添加项目</option>';
    select.disabled = true;
  } else {
    select.disabled = false;
    select.innerHTML = state.projects.map((project) => (
      `<option value="${escapeHtml(project.id)}">${escapeHtml(project.alias)}</option>`
    )).join('');
  }

  const projectById = new Map(state.projects.map((project) => [project.id, project]));
  const bindings = Object.entries(state.activeByChat || {});
  if (!bindings.length) {
    list.className = 'binding-list empty';
    list.textContent = '还没有飞书会话绑定。';
    return;
  }

  list.className = 'binding-list';
  list.innerHTML = bindings.map(([chatId, projectId]) => {
    const project = projectById.get(projectId);
    return `
      <div class="binding-row" data-chat-id="${escapeHtml(chatId)}">
        <code>${escapeHtml(chatId)}</code>
        <strong>${escapeHtml(project?.alias || '项目已删除')}</strong>
        <code>${escapeHtml(project?.threadId || '未绑定线程')}</code>
        <button type="button" class="danger remove-chat-binding">解除</button>
      </div>
    `;
  }).join('');
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function refreshState() {
  const state = await window.bridgeApi.getState();
  renderState(state);
}

function rerenderProjectLists() {
  const projects = stateRef.state?.projects || [];
  renderProjects('#dashboardProjects', projects.slice(0, 4), { compact: true });
  renderProjects('#projectList', projects, { compact: false });
}

function handleProjectCardClick(event) {
  const card = event.target.closest('.project-card');
  if (!card) return;
  const projectId = card.dataset.projectId;

  if (event.target.classList.contains('remove-project')) {
    runAction(() => window.bridgeApi.removeProject(projectId), '项目已删除');
    return;
  }

  if (event.target.closest('.project-toggle') || event.target.closest('.project-head')) {
    if (expandedProjectIds.has(projectId)) {
      expandedProjectIds.delete(projectId);
    } else {
      expandedProjectIds.add(projectId);
    }
    rerenderProjectLists();
    return;
  }

  if (event.target.classList.contains('send-status')) {
    runAction(() => window.bridgeApi.sendStatus(projectId), '状态已推送');
    return;
  }

  if (event.target.classList.contains('send-prompt')) {
    const prompt = card.querySelector('.prompt-box').value.trim();
    if (!prompt) {
      toast('请先输入指令');
      return;
    }
    runAction(() => window.bridgeApi.sendPrompt(projectId, prompt), '已发送到 Codex').then(() => {
      card.querySelector('.prompt-box').value = '';
    });
  }
}

function bindEvents() {
  $('#appVersionBadge').addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    showReleaseNotes();
  });

  document.addEventListener('click', (event) => {
    if (!event.target.closest('#appVersionBadge')) return;
    event.preventDefault();
    event.stopPropagation();
    showReleaseNotes();
  }, true);

  $$('.nav-item').forEach((node) => {
    node.addEventListener('click', () => setView(node.dataset.view));
  });

  $('#startBridge').addEventListener('click', () => runAction(() => window.bridgeApi.startBridge(), '桥接已启动'));
  $('#stopBridge').addEventListener('click', () => runAction(() => window.bridgeApi.stopBridge(), '桥接已停止'));

  $('#settingsForm').addEventListener('submit', (event) => {
    event.preventDefault();
    runAction(() => window.bridgeApi.saveSettings(getSettingsForm()), '配置已保存');
    $('#appSecret').value = '';
  });

  $('#testFeishu').addEventListener('click', () => runAction(() => window.bridgeApi.testFeishu(), '已发送测试消息'));
  $('#openFeishuLauncher').addEventListener('click', () => runAction(() => window.bridgeApi.openFeishuLauncher(), '已打开飞书创建页'));
  $('#resolveCodexBin').addEventListener('click', async () => {
    const resolved = await runAction(() => window.bridgeApi.resolveCodexBin(), '已识别 Codex 命令');
    $('#codexBin').value = resolved;
  });
  $('#checkAccessibility').addEventListener('click', async () => {
    await refreshPermissions();
    showPermissionModal();
    startPermissionPolling();
  });
  $('#releaseNotesClose').addEventListener('click', hideReleaseNotes);
  $('#releaseNotesDone').addEventListener('click', hideReleaseNotes);
  $('#releaseNotesGithub').addEventListener('click', () => runAction(() => window.bridgeApi.openReleases(), '已打开 GitHub 更新列表'));
  $('#updateAvailableButton').addEventListener('click', () => runAction(() => window.bridgeApi.openReleases(), '已打开 GitHub 更新列表'));
  $('#releaseNotesModal').addEventListener('click', (event) => {
    if (event.target.id === 'releaseNotesModal') hideReleaseNotes();
  });
  $('#openSetupGuide').addEventListener('click', () => showSetupGuide(0));
  $('#permissionModalClose').addEventListener('click', closePermissionGuide);
  $('#permissionDone').addEventListener('click', closePermissionGuide);
  $('#permissionModal').addEventListener('click', (event) => {
    if (event.target.id === 'permissionModal') closePermissionGuide();
  });
  $('#permissionRefresh').addEventListener('click', () => {
    refreshPermissions().then((status) => {
      toast(status?.allGranted ? '权限都已授权' : '还有权限未授权');
    });
  });
  $$('.permission-open').forEach((button) => {
    button.addEventListener('click', async () => {
      const type = button.dataset.openPermission;
      await runAction(() => window.bridgeApi.openPermissionSettings(type), '已打开系统设置');
      startPermissionPolling();
    });
  });
  $('#setupModalClose').addEventListener('click', () => {
    runAction(() => skipSetupGuide());
  });
  $('#setupSkip').addEventListener('click', () => {
    runAction(() => skipSetupGuide());
  });
  $('#setupBack').addEventListener('click', () => setSetupStep(stateRef.setupGuideStep - 1));
  $('#setupNext').addEventListener('click', () => {
    runAction(async () => {
      await saveSetupStep();
      if (stateRef.setupGuideStep >= SETUP_STEP_COUNT - 1) {
        await completeSetupGuide();
        return;
      }
      setSetupStep(stateRef.setupGuideStep + 1);
    });
  });
  $('#setupModal').addEventListener('click', (event) => {
    if (event.target.id === 'setupModal') {
      runAction(() => skipSetupGuide());
    }
  });
  $$('#setupModal [data-open-url]').forEach((button) => {
    button.addEventListener('click', () => {
      runAction(() => window.bridgeApi.openExternal(button.dataset.openUrl), '已打开飞书页面');
    });
  });
  $('#testCodex').addEventListener('click', async () => {
    const result = await runAction(() => window.bridgeApi.testCodex(), 'Codex 连接正常');
    $('#threadResults').textContent = JSON.stringify(result, null, 2);
  });
  $('#openUserData').addEventListener('click', () => runAction(() => window.bridgeApi.openUserData(), '已打开配置目录'));

  $('#chooseProjectDir').addEventListener('click', async () => {
    const directory = await window.bridgeApi.chooseDirectory();
    if (directory) $('#projectCwd').value = directory;
  });

  $('#projectForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const project = {
      alias: $('#projectAlias').value.trim(),
      cwd: $('#projectCwd').value.trim(),
      threadId: $('#projectThreadId').value.trim(),
      chatId: $('#projectChatId').value.trim()
    };
    runAction(() => window.bridgeApi.addProject(project), '项目已添加').then(() => {
      $('#projectAlias').value = '';
      $('#projectCwd').value = '';
      $('#projectThreadId').value = '';
      $('#projectChatId').value = '';
    });
  });

  $('#chatBindingForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const chatId = $('#bindingChatId').value.trim();
    const projectId = $('#bindingProjectId').value;
    if (!chatId || !projectId) {
      toast('请填写 Chat ID 并选择项目');
      return;
    }

    runAction(() => window.bridgeApi.bindChat(chatId, projectId), '飞书会话已绑定').then(() => {
      $('#bindingChatId').value = '';
    });
  });

  $('#chatBindingToggle').addEventListener('click', () => {
    const section = $('#chatBindingSection');
    const body = $('#chatBindingBody');
    const isExpanded = !section.classList.contains('collapsed');
    section.classList.toggle('collapsed', isExpanded);
    body.hidden = isExpanded;
    $('#chatBindingToggle').setAttribute('aria-expanded', String(!isExpanded));
  });

  $('#chatBindingList').addEventListener('click', (event) => {
    if (!event.target.classList.contains('remove-chat-binding')) return;
    const row = event.target.closest('.binding-row');
    const chatId = row?.dataset.chatId || '';
    if (!chatId) return;
    runAction(() => window.bridgeApi.removeChatBinding(chatId), '飞书会话绑定已解除');
  });

  $('#dashboardProjects').addEventListener('click', handleProjectCardClick);
  $('#projectList').addEventListener('click', handleProjectCardClick);

  $('#refreshThreads').addEventListener('click', async () => {
    const query = $('#threadQuery').value.trim();
    const result = await runAction(() => window.bridgeApi.listCodexThreads(query), '查询完成');
    $('#threadResults').textContent = JSON.stringify(result, null, 2);
  });

  window.bridgeApi.onState(renderState);
  window.bridgeApi.onLog(() => refreshState());
}

bindEvents();
startInitialGuides()
  .then(() => checkAppUpdates())
  .catch((error) => toast(error.message || String(error)));
