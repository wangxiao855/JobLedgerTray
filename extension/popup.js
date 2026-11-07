/* global JobLedgerCore */
(function () {
  'use strict';

  const C = window.JobLedgerCore;
  const $ = (id) => document.getElementById(id);

  let currentTab = null;
  let pageInfo = null;
  let state = { applications: [], settings: { followUpDays: 7 } };
  let saveTimer = null;

  function send(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(response || { ok: false, error: '没有收到扩展响应' });
      });
    });
  }

  function tabsSend(tabId, message) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(response);
      });
    });
  }

  function fallbackInfo(tab) {
    const title = tab && tab.title ? tab.title : '';
    const url = tab && /^https?:/i.test(tab.url || '') ? tab.url : '';
    const company = C.pickCompanyFromTitle(title);
    return {
      company: company || '待确认',
      role: C.pickRoleFromTitle(title, company) || '待确认',
      status: 'applied',
      url,
      source: C.hostOf(url),
      pageTitle: title,
      detection: 'manual'
    };
  }

  function renderStatusOptions() {
    $('status').innerHTML = C.STATUSES.map((status) => {
      return '<option value="' + status.id + '">' + C.escapeHtml(status.label) + '</option>';
    }).join('');
  }

  function renderPage(info) {
    const pill = $('detect');
    pill.className = 'pill';
    if (info.detection === 'success') {
      pill.textContent = '疑似成功页';
      pill.classList.add('success');
    } else if (info.detection === 'job') {
      pill.textContent = '招聘页';
      pill.classList.add('job');
    } else {
      pill.textContent = '手动记录';
      pill.classList.add('manual');
    }

    $('company').value = info.company && info.company !== '待确认' ? info.company : '';
    $('role').value = info.role && info.role !== '待确认' ? info.role : '';
    $('url').textContent = info.url || '当前页面不支持自动读取，手动填写即可';
    $('url').title = info.url || '';

    if (info.detection === 'success') {
      showHint('检测到投递成功页，确认信息后保存。', '');
    } else if (!info.url) {
      showHint('这个页面不能自动读取，但可以手动记录。', '');
    } else {
      showHint('', '');
    }
  }

  function showHint(message, type) {
    const hint = $('hint');
    hint.textContent = message || '';
    hint.className = 'hint' + (type ? ' ' + type : '');
  }

  function renderStats() {
    const applications = state.applications || [];
    $('statActive').textContent = applications.filter((application) => C.isActive(application.status)).length;
    $('statFollow').textContent = applications.filter((application) => C.needsFollowUp(application, state.settings.followUpDays || 7)).length;
    $('statOffer').textContent = applications.filter((application) => application.status === 'offer').length;
  }

  function renderRecent() {
    const list = $('recentList');
    const applications = C.sortByUpdated(state.applications || []).slice(0, 4);
    if (!applications.length) {
      list.innerHTML = '<div class="empty-line">还没有记录，先从当前页面记一笔</div>';
      return;
    }
    list.innerHTML = applications.map((application) => {
      const status = C.getStatus(application.status);
      return `
        <div class="recent-item" data-id="${C.escapeHtml(application.id)}" role="button" tabindex="0">
          <span class="avatar" style="--av:${C.colorFor(application.company)}">${C.escapeHtml(C.initials(application.company))}</span>
          <div class="recent-main">
            <div class="recent-company">${C.escapeHtml(application.company)}</div>
            <div class="recent-role">${C.escapeHtml(application.role)}</div>
          </div>
          <div class="recent-status" style="--sc:${status.color}">
            <span class="dot"></span>${C.escapeHtml(status.label)}
          </div>
        </div>
      `;
    }).join('');
  }

  async function refreshState() {
    try {
      const response = await send({ type: 'GET_STATE' });
      if (response && response.ok && response.state) {
        state = response.state;
      }
    } catch (error) {
      /* keep the popup usable even if the worker is restarting */
    }
    renderStats();
    renderRecent();
  }

  async function loadPage() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tabs && tabs[0] ? tabs[0] : null;
    if (currentTab && /^https?:/i.test(currentTab.url || '')) {
      try {
        pageInfo = await tabsSend(currentTab.id, { type: 'EXTRACT_PAGE' });
      } catch (error) {
        pageInfo = null;
      }
    }
    if (!pageInfo) pageInfo = fallbackInfo(currentTab);
    renderPage(pageInfo);
  }

  async function save() {
    if (!pageInfo) return;
    const company = $('company').value.trim();
    const role = $('role').value.trim();
    if (!company && !role) {
      showHint('至少填写公司或岗位，之后才好找。', 'error');
      $('company').focus();
      return;
    }

    const button = $('save');
    button.disabled = true;
    button.textContent = '保存中…';
    showHint('', '');

    try {
      const response = await send({
        type: 'SAVE_APPLICATION',
        payload: Object.assign({}, pageInfo, {
          company: company || '待确认',
          role: role || '待确认',
          status: $('status').value,
          notes: $('notes').value.trim(),
          capture: 'popup'
        })
      });
      if (!response || !response.ok) throw new Error((response && response.error) || '保存失败');
      state = response.state || state;
      renderStats();
      renderRecent();
      const message = response.duplicate
        ? '这个页面已经有记录，已为你更新。'
        : '已记录 · 今天第 ' + response.todayCount + ' 家';
      showHint(message, 'success');
      button.textContent = '已保存 ✓';
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        button.textContent = '保存这次投递';
      }, 1800);
    } catch (error) {
      showHint(error && error.message ? error.message : '保存失败，请重试', 'error');
      button.textContent = '保存这次投递';
    } finally {
      button.disabled = false;
    }
  }

  function openDashboard(focus) {
    send({ type: 'OPEN_DASHBOARD', focus: focus || '' })
      .catch(() => {})
      .finally(() => window.close());
  }

  function bind() {
    $('save').addEventListener('click', save);
    $('openDashboard').addEventListener('click', () => openDashboard(''));
    $('openDashboard2').addEventListener('click', () => openDashboard(''));
    $('recentList').addEventListener('click', (event) => {
      const item = event.target.closest('.recent-item');
      if (item && item.dataset.id) openDashboard(item.dataset.id);
    });
    $('recentList').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const item = event.target.closest('.recent-item');
      if (item && item.dataset.id) {
        event.preventDefault();
        openDashboard(item.dataset.id);
      }
    });
    ['company', 'role', 'notes'].forEach((id) => {
      $(id).addEventListener('keydown', (event) => {
        if (event.key === 'Enter') save();
      });
    });
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes.jobledger || !changes.jobledger.newValue) return;
      state = changes.jobledger.newValue;
      renderStats();
      renderRecent();
    });
  }

  async function init() {
    renderStatusOptions();
    bind();
    await refreshState();
    await loadPage();
  }

  init();
})();
