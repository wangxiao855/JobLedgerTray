/* global JobLedgerCore */
(function () {
  'use strict';

  const C = window.JobLedgerCore;
  const $ = (selector) => document.querySelector(selector);

  const FILTERS = [
    { id: 'all', label: '全部' },
    { id: 'active', label: '进行中' },
    { id: 'interview', label: '面试中' },
    { id: 'followup', label: '待跟进' },
    { id: 'offer', label: 'Offer' },
    { id: 'closed', label: '已结束' }
  ];

  const BOARD_COLUMNS = [
    { id: 'applied', title: '已投递', statuses: ['applied'], color: '#64748b' },
    { id: 'screening', title: '筛选中', statuses: ['screening'], color: '#2563eb' },
    { id: 'test', title: '测评 / 笔试', statuses: ['assessment', 'written'], color: '#d97706' },
    { id: 'interview', title: '面试', statuses: ['interview1', 'interview2', 'interview3', 'hr'], color: '#0891b2' },
    { id: 'offer', title: 'Offer', statuses: ['offer'], color: '#16a34a' },
    { id: 'closed', title: '已结束', statuses: ['rejected', 'ghosted'], color: '#94a3b8' }
  ];

  const initialView = new URLSearchParams(location.search).get('view');
  const ui = {
    filter: 'all',
    query: '',
    sort: 'updated',
    view: initialView === 'board' || initialView === 'list'
      ? initialView
      : (localStorage.getItem('jobledger:view') === 'board' ? 'board' : 'list'),
    editingId: null,
    previousOverflow: '',
    expandedCompanies: new Set()
  };

  let state = { applications: [], settings: { followUpDays: 7 } };
  let emailServiceError = '';
  let toastTimer = null;
  let searchTimer = null;

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

  function showToast(message, type) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.className = 'toast show' + (type ? ' ' + type : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.className = 'toast';
    }, 2800);
  }

  function statusOptions(selected) {
    return C.STATUSES.map((status) => {
      return '<option value="' + status.id + '"' + (status.id === selected ? ' selected' : '') + '>' + C.escapeHtml(status.label) + '</option>';
    }).join('');
  }

  function statusSelect(application) {
    const status = C.getStatus(application.status);
    return '<select class="status-select" data-action="status" data-id="' + C.escapeHtml(application.id) + '"' +
      ' style="--sc:' + status.color + ';--sb:' + status.bg + '" aria-label="更新投递状态">' +
      statusOptions(application.status) + '</select>';
  }

  function getCounts() {
    const applications = state.applications || [];
    const companies = new Set(applications.map((application) => String(application.company || '').trim() || '待确认'));
    return {
      all: applications.length,
      companies: companies.size,
      active: applications.filter((application) => C.isActive(application.status)).length,
      interview: applications.filter((application) => C.isInterview(application.status)).length,
      followup: applications.filter((application) => C.needsFollowUp(application, state.settings.followUpDays || 7)).length,
      offer: applications.filter((application) => application.status === 'offer').length,
      closed: applications.filter((application) => C.isClosed(application.status)).length
    };
  }

  function visibleApplications() {
    let applications = (state.applications || []).slice();
    if (ui.filter === 'active') applications = applications.filter((application) => C.isActive(application.status));
    else if (ui.filter === 'interview') applications = applications.filter((application) => C.isInterview(application.status));
    else if (ui.filter === 'followup') applications = applications.filter((application) => C.needsFollowUp(application, state.settings.followUpDays || 7));
    else if (ui.filter === 'offer') applications = applications.filter((application) => application.status === 'offer');
    else if (ui.filter === 'closed') applications = applications.filter((application) => C.isClosed(application.status));

    const query = ui.query.trim().toLowerCase();
    if (query) {
      applications = applications.filter((application) => {
        const emailText = (application.emails || []).map((email) => email.subject).join(' ');
        return [application.company, application.role, application.notes, application.source, emailText]
          .join(' ')
          .toLowerCase()
          .includes(query);
      });
    }

    applications.sort((a, b) => {
      if (ui.sort === 'company') return String(a.company).localeCompare(String(b.company), 'zh-Hans-CN');
      if (ui.sort === 'applied') {
        return new Date(b.appliedAt || b.createdAt || 0) - new Date(a.appliedAt || a.createdAt || 0);
      }
      return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
    });

    return applications;
  }

  function renderStats() {
    const counts = getCounts();
    const cards = [
      { filter: 'all', label: '公司', value: counts.companies, tone: '', sub: counts.all + ' 个岗位' },
      { filter: 'active', label: '进行中', value: counts.active, tone: 'tone-active', sub: '还在等进展' },
      { filter: 'interview', label: '面试中', value: counts.interview, tone: 'tone-interview', sub: '一面到 HR 面' },
      { filter: 'followup', label: '待跟进', value: counts.followup, tone: 'tone-warn', sub: '7 天未更新' },
      { filter: 'offer', label: 'Offer', value: counts.offer, tone: 'tone-good', sub: '已经拿到' }
    ];

    $('#stats').innerHTML = cards.map((card) => {
      const active = ui.filter === card.filter ? ' is-active' : '';
      return '<button type="button" class="stat-card ' + card.tone + active + '" data-filter="' + card.filter + '">' +
        '<span class="stat-label"><span>' + card.label + '</span><span>›</span></span>' +
        '<span class="stat-num">' + card.value + '</span>' +
        '<span class="stat-sub">' + card.sub + '</span>' +
        '</button>';
    }).join('');
  }

  function renderFilters() {
    const counts = getCounts();
    $('#filters').innerHTML = FILTERS.map((filter) => {
      const count = filter.id === 'all' ? counts.companies : (counts[filter.id] || 0);
      return '<button type="button" class="chip ' + (ui.filter === filter.id ? 'active' : '') + '" data-filter="' + filter.id + '">' +
        filter.label + '<span class="count">' + count + '</span>' +
        '</button>';
    }).join('');
  }

  function appliedDate(application) {
    const times = (application.emails || [])
      .map((email) => new Date(email.occurredAt || 0).getTime())
      .filter((time) => Number.isFinite(time) && time > 0);
    if (times.length) return new Date(Math.min(...times)).toISOString();
    return application.appliedAt || application.createdAt;
  }

  function emailCategoryForStatus(status) {
    if (status === 'written') return 'written';
    if (status === 'assessment') return 'assessment';
    if (status === 'offer') return 'offer';
    if (status === 'rejected') return 'rejection';
    if (['interview1', 'interview2', 'interview3', 'hr'].includes(status)) return 'interview';
    if (status === 'screening') return 'screening';
    return 'application';
  }

  function emailCategoryLabel(email) {
    const labels = {
      application: '投递',
      screening: '筛选',
      assessment: '测评',
      written: '笔试',
      interview: '面试',
      offer: 'Offer',
      rejection: '拒绝',
      other: '其他'
    };
    return labels[email.category] || C.getStatus(email.status).label;
  }

  function companyKey(name) {
    return String(name || '待确认').trim().toLowerCase() || '待确认';
  }

  function companyGroups() {
    const visibleIds = new Set(visibleApplications().map((application) => application.id));
    const globalEmails = (state.emailEvents || []).map((email) => ({
      id: email.id,
      company: email.company || '',
      role: email.role || '',
      subject: email.subject || '',
      category: email.category || emailCategoryForStatus(email.status),
      status: email.status,
      emailType: email.emailType || email.email_type || (email.role && email.status !== 'unknown' ? 'application' : 'other'),
      groupTitle: email.groupTitle || email.group_title || '',
      messageId: email.messageId || email.message_id || '',
      applicationId: email.applicationId || '',
      unread: Boolean(email.unread),
      occurredAt: email.occurredAt || email.occurred_at,
      from: email.from || email.from_email || '',
      url: email.url || '',
      webmailUrl: email.webmailUrl || email.webmail_url || '',
      snippet: email.snippet || '',
      classifiedBy: email.classifiedBy || email.classified_by || 'rules',
      confidence: email.confidence || 0
    }));
    const map = new Map();
    (state.applications || []).forEach((application) => {
      const name = C.cleanText(application.company) || '待确认';
      const key = companyKey(name);
      let group = map.get(key);
      if (!group) {
        group = { key, name, apps: [], emails: [] };
        map.set(key, group);
      }
      group.apps.push(application);
    });

    globalEmails.forEach((email) => {
      const name = C.cleanText(email.company) || '';
      if (!name || name === '待确认') return;
      const key = companyKey(name);
      if (!map.has(key)) map.set(key, { key, name, apps: [], emails: [] });
    });

    const groups = [];
    map.forEach((group) => {
      group.visibleApps = group.apps.filter((application) => visibleIds.has(application.id));
      const groupGlobalEmails = globalEmails.filter((email) => companyKey(email.company) === group.key);
      const isEmailOnly = !group.apps.length && groupGlobalEmails.length > 0;
      if (!group.visibleApps.length && !(isEmailOnly && ui.filter === 'all')) return;

      const emails = globalEmails.filter((email) => companyKey(email.company) === group.key);
      const hasGlobal = emails.length > 0;
      group.apps.forEach((application) => {
        (application.emails || []).forEach((email) => emails.push(email));
        if (!hasGlobal && (!application.emails || !application.emails.length) && application.emailSubject) {
          emails.push({
            id: 'legacy-' + application.id,
            subject: application.emailSubject,
            category: application.emailCategory || emailCategoryForStatus(application.status),
            status: application.status,
            occurredAt: application.updatedAt,
            from: application.emailFrom,
            classifiedBy: 'rules'
          });
        }
      });
      const seen = new Set();
      group.emails = emails
        .filter((email) => email && email.subject && !seen.has(email.id) && seen.add(email.id))
        .sort((a, b) => new Date(b.occurredAt || 0) - new Date(a.occurredAt || 0))
        .slice(0, 50);
      group.applicationEmails = group.emails.filter((email) => {
        const type = email.emailType || (email.role && email.status !== 'unknown' ? 'application' : 'other');
        return type !== 'other' && email.role && email.role !== '待确认';
      });
      group.otherEmails = group.emails.filter((email) => {
        const type = email.emailType || (email.role && email.status !== 'unknown' ? 'application' : 'other');
        return type === 'other' || !email.role || email.role === '待确认';
      });
      group.visibleApps.sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
      group.latest = group.visibleApps[0] || null;
      group.follow = group.visibleApps.some((application) => C.needsFollowUp(application, state.settings.followUpDays || 7));
      group.hasOffer = group.visibleApps.some((application) => application.status === 'offer');
      groups.push(group);
    });

    groups.sort((a, b) => {
      if (ui.sort === 'company') return a.name.localeCompare(b.name, 'zh-Hans-CN');
      const aTime = new Date((a.latest && (a.latest.updatedAt || a.latest.createdAt)) || a.emails[0]?.occurredAt || 0).getTime();
      const bTime = new Date((b.latest && (b.latest.updatedAt || b.latest.createdAt)) || b.emails[0]?.occurredAt || 0).getTime();
      return bTime - aTime;
    });
    return groups;
  }

  function roleKey(value) {
    return String(value || '').toLowerCase().replace(/\s+/g, '').replace(/[（）()]/g, '');
  }

  function routeCompanyEmails(group) {
    const apps = group.apps.slice();
    const byId = new Map(apps.map((application) => [application.id, application]));
    const routes = new Map();
    (group.applicationEmails || group.emails).forEach((email) => {
      let application = email.applicationId ? byId.get(email.applicationId) : null;
      if (!application && email.role) {
        const key = roleKey(email.role);
        application = apps.find((app) => roleKey(app.role) === key) ||
          apps.find((app) => {
            const appKey = roleKey(app.role);
            return appKey && (appKey.includes(key) || key.includes(appKey));
          }) || null;
      }
      if (!application && apps.length === 1) application = apps[0];
      const routeKey = application ? application.id : 'unmatched';
      if (!routes.has(routeKey)) {
        routes.set(routeKey, {
          key: routeKey,
          application,
          title: application ? application.role : (email.role || '未匹配岗位'),
          emails: []
        });
      }
      routes.get(routeKey).emails.push(email);
    });
    const appOrder = new Map(group.apps.map((application, index) => [application.id, index]));
    return Array.from(routes.values()).sort((a, b) => {
      if (a.key === 'unmatched') return 1;
      if (b.key === 'unmatched') return -1;
      return (appOrder.get(a.key) || 0) - (appOrder.get(b.key) || 0);
    });
  }

  function emailItemHtml(email) {
    const status = C.getStatus(email.status);
    const hasLink = email.webmailUrl && C.isHttpUrl(email.webmailUrl);
    const subject = C.escapeHtml(email.subject);
    return '<div class="company-email' + (email.unread ? ' is-unread' : '') + '">' +
      '<span class="email-status-dot" style="--sc:' + status.color + '"></span>' +
      '<div class="company-email-body">' +
        '<div class="company-email-subject" title="' + C.escapeHtml(email.subject) + '">' +
          (hasLink
            ? '<a class="company-email-link" href="' + C.escapeHtml(email.webmailUrl) + '" target="_blank" rel="noopener">' + subject + ' ↗</a>'
            : subject) +
        '</div>' +
        '<div class="company-email-meta">' + C.escapeHtml(C.formatDate(email.occurredAt, true)) + ' · ' +
          C.escapeHtml(emailCategoryLabel(email)) +
          (email.classifiedBy === 'llm' ? ' · AI' : '') +
        '</div>' +
        (email.snippet ? '<div class="company-email-snippet">' + C.escapeHtml(C.truncate(email.snippet, 90)) + '</div>' : '') +
      '</div>' +
    '</div>';
  }

  function renderPositionRow(application, emailCount, emailUnread) {
    const status = C.getStatus(application.status);
    const host = C.hostOf(application.url);
    const source = host || application.source || '';
    const notes = application.notes ? ' · ' + C.truncate(application.notes, 34) : '';
    const focus = application.id === ui.editingId ? ' is-focus' : '';
    return '<tr data-id="' + C.escapeHtml(application.id) + '" class="' + focus + '">' +
      '<td><div class="position-role">' + C.escapeHtml(application.role) +
        '<div class="role-line" title="' + C.escapeHtml(application.role + notes) + '">' + C.escapeHtml(notes.replace(/^ · /, '')) + '</div></div></td>' +
      '<td>' + statusSelect(application) + '</td>' +
      '<td><div class="date">' + C.escapeHtml(C.formatDate(appliedDate(application))) + '</div><div class="sub">' + C.escapeHtml(C.relativeDay(appliedDate(application))) + '</div></td>' +
      '<td><div class="date">' + C.escapeHtml(C.relativeDay(application.updatedAt || application.createdAt)) + '</div><div class="sub" title="' + C.escapeHtml(C.formatDate(application.updatedAt, true)) + '">' + C.escapeHtml(C.formatDate(application.updatedAt, true)) + '</div></td>' +
      '<td>' + (emailCount ? '<span class="position-email-count' + (emailUnread ? ' has-new' : '') + '">' + emailCount + ' 封' + (emailUnread ? ' · 新' : '') + '</span>' : '<span class="sub">—</span>') + '</td>' +
      '<td>' + (application.url && C.isHttpUrl(application.url)
        ? '<a class="url-link" href="' + C.escapeHtml(application.url) + '" target="_blank" rel="noopener" title="' + C.escapeHtml(application.url) + '"><span>' + C.escapeHtml(source || '打开') + '</span><span class="url-arrow">↗</span></a>'
        : '<span class="sub">—</span>') + '</td>' +
      '<td><div class="row-actions">' +
        '<button type="button" data-action="edit" data-id="' + C.escapeHtml(application.id) + '">编辑</button>' +
        (application.url && C.isHttpUrl(application.url) ? '<a class="action-link" href="' + C.escapeHtml(application.url) + '" target="_blank" rel="noopener">打开</a>' : '') +
        '<button type="button" class="danger-text" data-action="delete" data-id="' + C.escapeHtml(application.id) + '">删除</button>' +
      '</div></td>' +
    '</tr>';
  }

  function renderCompanyCard(group) {
    const expanded = ui.expandedCompanies.has(group.key);
    const latestStatus = group.latest ? C.getStatus(group.latest.status) : { label: '仅邮件', color: '#64748b' };
    const latestEmail = group.emails[0];
    const otherCount = (group.otherEmails || []).length;
    const emailSummary = group.emails.length
      ? group.emails.length + ' 封 · ' + (latestEmail ? C.truncate(latestEmail.subject, 26) : '') +
        (otherCount ? ' · 其他 ' + otherCount : '')
      : '暂无邮件';
    const routes = routeCompanyEmails(group);
    const otherEmails = group.otherEmails || [];
    const mailCounts = new Map();
    const mailUnread = new Map();
    routes.forEach((route) => {
      if (route.application) {
        mailCounts.set(route.application.id, route.emails.length);
        mailUnread.set(route.application.id, route.emails.filter((email) => email.unread).length);
      }
    });
    const totalUnread = group.emails.filter((email) => email.unread).length;
    const emailItems = group.applicationEmails && group.applicationEmails.length
      ? routes.map((route) => {
          const unread = route.emails.filter((email) => email.unread).length;
          return '<div class="email-route">' +
            '<div class="email-route-head">' +
              '<span title="' + C.escapeHtml(route.title) + '">' + C.escapeHtml(route.title) + '</span>' +
              '<span>' + route.emails.length + (unread ? ' · 新 ' + unread : '') + '</span>' +
            '</div>' +
            route.emails.map(emailItemHtml).join('') +
          '</div>';
        }).join('')
      : '';
    const otherRoutes = new Map();
    otherEmails.forEach((email) => {
      const title = email.groupTitle || '其他邮件';
      if (!otherRoutes.has(title)) otherRoutes.set(title, []);
      otherRoutes.get(title).push(email);
    });
    const otherHtml = otherEmails.length
      ? Array.from(otherRoutes.entries()).map(([title, emails]) => {
          const unread = emails.filter((email) => email.unread).length;
          return '<div class="email-route other-email-route">' +
            '<div class="email-route-head other-email-head">' +
              '<span title="' + C.escapeHtml(title) + '">' + C.escapeHtml(title) + '</span>' +
              '<span>' + emails.length + (unread ? ' · 新 ' + unread : '') + '</span>' +
            '</div>' +
            emails.map(emailItemHtml).join('') +
          '</div>';
        }).join('')
      : '';
    const emailEmpty = !routes.length && !otherEmails.length
      ? '<div class="company-email-empty">这个公司还没有匹配到邮件</div>'
      : '';

    return '<article class="company-card' + (expanded ? ' is-expanded' : '') + '" data-company-key="' + C.escapeHtml(group.key) + '">' +
      '<header class="company-header" data-action="toggle-company" data-key="' + C.escapeHtml(group.key) + '" data-company-name="' + C.escapeHtml(group.name) + '" aria-expanded="' + String(expanded) + '" tabindex="0" role="button">' +
        '<div class="company-main">' +
          '<span class="avatar" style="--av:' + C.colorFor(group.name) + '">' + C.escapeHtml(C.initials(group.name)) + '</span>' +
          '<div class="company-copy">' +
            '<div class="company-heading">' +
              '<h3>' + C.escapeHtml(group.name) + '</h3>' +
              (group.follow ? '<span class="flag">待跟进</span>' : '') +
              (group.hasOffer ? '<span class="flag offer">Offer</span>' : '') +
              (totalUnread ? '<span class="unread-badge">新 ' + totalUnread + '</span>' : '') +
            '</div>' +
            '<div class="company-meta">' + group.visibleApps.length + ' 个岗位 · ' +
              C.escapeHtml(latestStatus.label) +
              (group.latest
                ? ' · ' + C.escapeHtml(C.relativeDay(group.latest.updatedAt || group.latest.createdAt))
                : (latestEmail ? ' · ' + C.escapeHtml(C.relativeDay(latestEmail.occurredAt)) : '')) +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="company-email-summary">' +
          '<span class="email-summary-label">邮件</span>' +
          '<span class="email-summary-text" title="' + C.escapeHtml(emailSummary) + '">' + C.escapeHtml(emailSummary) + '</span>' +
        '</div>' +
        '<span class="company-chevron">' + (expanded ? '⌄' : '›') + '</span>' +
      '</header>' +
      '<div class="company-body">' +
        '<div class="company-body-inner">' +
        '<div class="company-positions">' +
          '<div class="table-wrap"><table class="ledger company-ledger">' +
            '<thead><tr><th>岗位</th><th>状态</th><th>投递</th><th>最近更新</th><th>邮件</th><th>投递网址</th><th></th></tr></thead>' +
            '<tbody>' + (group.visibleApps.length
              ? group.visibleApps.map((application) => renderPositionRow(application, mailCounts.get(application.id) || 0, mailUnread.get(application.id) || 0)).join('')
              : '<tr><td colspan="7" class="company-email-empty">还没有对应岗位，其他邮件见右侧。</td></tr>') + '</tbody>' +
          '</table></div>' +
        '</div>' +
        '<aside class="company-emails">' +
          '<div class="company-emails-head"><span>邮件情况</span><span>' + group.emails.length + (totalUnread ? ' · 新 ' + totalUnread : '') + '</span></div>' +
          '<div class="company-email-list">' + emailItems + otherHtml + emailEmpty + '</div>' +
        '</aside>' +
        '</div>' +
      '</div>' +
    '</article>';
  }

  function renderList() {
    const groups = companyGroups();
    if (!groups.length) {
      $('#listView').innerHTML = '<div class="no-results"><strong>没有匹配的公司</strong>换个关键词，或者把筛选切回「全部」。</div>';
      return;
    }
    $('#listView').innerHTML = '<div class="company-list">' + groups.map(renderCompanyCard).join('') + '</div>';
  }

  function kanbanCard(application) {
    const status = C.getStatus(application.status);
    const follow = C.needsFollowUp(application, state.settings.followUpDays || 7);
    return '<article class="kanban-card" data-id="' + C.escapeHtml(application.id) + '" tabindex="0" role="button" aria-label="编辑 ' + C.escapeHtml(application.company + ' ' + application.role) + '">' +
      '<div class="kanban-top">' +
        '<span class="avatar tiny" style="--av:' + C.colorFor(application.company) + '">' + C.escapeHtml(C.initials(application.company)) + '</span>' +
        '<span class="kanban-company">' + C.escapeHtml(application.company) + '</span>' +
        (follow ? '<span class="flag">待跟进</span>' : '') +
        (application.capture === 'email' || (application.emailEventIds && application.emailEventIds.length) ? '<span class="flag email">邮件</span>' : '') +
      '</div>' +
      '<div class="kanban-role" title="' + C.escapeHtml(application.role) + '">' + C.escapeHtml(application.role) + '</div>' +
      '<div class="kanban-meta">' +
        '<span class="status-pill" style="--sc:' + status.color + ';--sb:' + status.bg + '">' + C.escapeHtml(status.label) + '</span>' +
        '<span>' + C.escapeHtml(C.relativeDay(application.updatedAt || application.createdAt)) + '</span>' +
      '</div>' +
      (application.url && C.isHttpUrl(application.url)
        ? '<a class="kanban-link" href="' + C.escapeHtml(application.url) + '" target="_blank" rel="noopener" title="' + C.escapeHtml(application.url) + '">查看投递页 ↗</a>'
        : '') +
    '</article>';
  }

  function renderBoard(applications) {
    $('#boardView').innerHTML = BOARD_COLUMNS.map((column) => {
      const items = applications.filter((application) => column.statuses.includes(application.status));
      const cards = items.length
        ? items.map(kanbanCard).join('')
        : '<div class="column-empty">暂无</div>';
      return '<div class="board-column">' +
        '<div class="column-head">' +
          '<span class="column-title"><span class="column-dot" style="--cc:' + column.color + '"></span>' + column.title + '</span>' +
          '<span class="column-count">' + items.length + '</span>' +
        '</div>' +
        cards +
      '</div>';
    }).join('');
  }

  function renderView() {
    const hasApplications = state.applications.length > 0;
    $('#viewList').classList.toggle('active', ui.view === 'list');
    $('#viewBoard').classList.toggle('active', ui.view === 'board');
    $('#listView').classList.toggle('hidden', !hasApplications || ui.view !== 'list');
    $('#boardView').classList.toggle('hidden', !hasApplications || ui.view !== 'board');
  }

  function renderEmpty() {
    const hasApplications = state.applications.length > 0;
    $('#emptyState').classList.toggle('hidden', hasApplications);
    $('#toolbar').classList.toggle('hidden', !hasApplications);
  }

  function renderHero() {
    const counts = getCounts();
    $('#heroSub').textContent = counts.all
      ? '共 ' + counts.companies + ' 家公司 · ' + counts.all + ' 个岗位 · ' + counts.followup + ' 个待跟进'
      : '投完 5 秒记一笔，进度不再翻官网。';
  }

  function render() {
    renderStats();
    renderFilters();
    const applications = visibleApplications();
    renderList();
    renderBoard(applications);
    renderView();
    renderEmpty();
    renderHero();
    renderEmailIndicator();
  }

  function emailConfig() {
    return (state.settings && state.settings.emailSync) || {
      enabled: false,
      url: 'http://127.0.0.1:8787',
      token: '',
      lastSyncAt: '',
      lastError: '',
      lastResult: null
    };
  }

  function renderEmailIndicator() {
    const config = emailConfig();
    const error = emailServiceError || config.lastError;
    const healthy = config.enabled && Boolean(config.lastSyncAt) && !error;
    const dot = $('#emailDot');
    dot.className = 'email-dot' + (healthy ? ' on' : '') + (error ? ' error' : '');
    if (error) {
      $('#emailBtn').title = '邮件同步失败：' + error;
    } else if (healthy) {
      $('#emailBtn').title = '邮件自动同步已启用，最近一次同步成功';
    } else if (config.enabled) {
      $('#emailBtn').title = '邮件自动同步已启用，等待首次成功同步';
    } else {
      $('#emailBtn').title = '邮件自动同步未启用';
    }
  }

  function renderEmailStatus() {
    const config = emailConfig();
    const line = $('#emailStatus');
    line.className = 'email-status';
    if (!config.enabled) {
      line.textContent = '自动同步未启用。保存后每 5 分钟检查一次；也可以点「立即同步」手动拉取。';
      return;
    }
    if (config.lastError) {
      line.classList.add('error');
      line.textContent = '上次同步失败：' + config.lastError;
      return;
    }
    if (config.lastSyncAt) {
      line.classList.add('ok');
      const result = config.lastResult;
      const detail = result
        ? ' · 新邮件 ' + (result.imported || 0) + '，更新记录 ' + (result.updated || 0) + '，跳过 ' + (result.skipped || 0)
        : '';
      line.textContent = '上次同步：' + C.formatDate(config.lastSyncAt, true) + '（' + C.relativeDay(config.lastSyncAt) + '）' + detail;
      return;
    }
    line.textContent = '已启用，还没有同步过。点「立即同步」或等下一次自动检查。';
  }

  function openEmailModal() {
    if (!$('#editModal').classList.contains('hidden')) closeEdit();
    const config = emailConfig();
    $('#emailEnabled').checked = Boolean(config.enabled);
    $('#emailUrl').value = config.url || 'http://127.0.0.1:8787';
    $('#emailToken').value = config.token || '';
    $('#emailImapHost').value = '';
    $('#emailImapPort').value = '993';
    $('#emailImapUser').value = '';
    $('#emailImapPassword').value = '';
    $('#emailImapMailbox').value = 'INBOX';
    $('#emailSearchDays').value = '365';
    $('#emailMaxMessages').value = '500';
    $('#emailLlmEnabled').checked = false;
    $('#emailLlmBaseUrl').value = '';
    $('#emailLlmModel').value = '';
    $('#emailLlmApiKey').value = '';
    renderEmailStatus();
    ui.previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    $('#emailModal').classList.remove('hidden', 'is-closing');
    setTimeout(() => $('#emailImapHost').focus(), 40);
    loadImapConfig();
  }

  function clearCompanyUnread(card) {
    if (!card) return;
    card.querySelectorAll('.unread-badge').forEach((badge) => badge.remove());
    card.querySelectorAll('.company-email.is-unread').forEach((email) => email.classList.remove('is-unread'));
    card.querySelectorAll('.email-route-head span:last-child, .company-emails-head span:last-child').forEach((label) => {
      label.textContent = label.textContent.replace(/\s*·\s*新\s*\d+/g, '');
    });
    card.querySelectorAll('.position-email-count.has-new').forEach((badge) => {
      badge.classList.remove('has-new');
      badge.textContent = badge.textContent.replace(/\s*·\s*新/g, '');
    });
  }

  function hideModal(id) {
    const modal = document.getElementById(id);
    if (!modal || modal.classList.contains('hidden')) return;
    modal.classList.add('is-closing');
    setTimeout(() => {
      if (!modal.classList.contains('is-closing')) return;
      modal.classList.add('hidden');
      modal.classList.remove('is-closing');
    }, 170);
  }

  function closeEmailModal() {
    hideModal('emailModal');
    document.body.style.overflow = ui.previousOverflow || '';
  }

  function emailPatch() {
    return {
      enabled: $('#emailEnabled').checked,
      url: $('#emailUrl').value.trim(),
      token: $('#emailToken').value.trim()
    };
  }

  function imapPatch() {
    return {
      imap_host: $('#emailImapHost').value.trim(),
      imap_port: Number($('#emailImapPort').value) || 993,
      username: $('#emailImapUser').value.trim(),
      password: $('#emailImapPassword').value,
      mailbox: $('#emailImapMailbox').value.trim() || 'INBOX',
      search_days: Number($('#emailSearchDays').value) || 365,
      max_messages: Number($('#emailMaxMessages').value) || 500,
      llm_enabled: $('#emailLlmEnabled').checked,
      llm_base_url: $('#emailLlmBaseUrl').value.trim(),
      llm_model: $('#emailLlmModel').value.trim(),
      llm_api_key: $('#emailLlmApiKey').value
    };
  }

  async function loadImapConfig() {
    const line = $('#emailStatus');
    try {
      const response = await send({ type: 'GET_IMAP_CONFIG' });
      if (!response || !response.ok) throw new Error((response && response.error) || '读取配置失败');
      emailServiceError = '';
      renderEmailIndicator();
      $('#emailImapHost').value = response.imap_host || '';
      $('#emailImapPort').value = response.imap_port || 993;
      $('#emailImapUser').value = response.username || '';
      $('#emailImapMailbox').value = response.mailbox || 'INBOX';
      $('#emailSearchDays').value = response.search_days || 365;
      $('#emailMaxMessages').value = response.max_messages || 500;
      $('#emailLlmEnabled').checked = Boolean(response.llm_enabled);
      $('#emailLlmBaseUrl').value = response.llm_base_url || '';
      $('#emailLlmModel').value = response.llm_model || '';
      $('#emailLlmApiKey').value = '';
      if (!response.configured) {
        line.className = 'email-status';
        line.textContent = '托盘服务已连接，但还没有配置 IMAP。填好上面的邮箱信息后点「保存」。';
      } else {
        line.className = 'email-status ok';
        line.textContent = '托盘服务已连接 · IMAP 已配置 · 文件夹：' + (response.mailbox || 'INBOX');
      }
    } catch (error) {
      emailServiceError = '连不上本地托盘服务';
      renderEmailIndicator();
      line.className = 'email-status error';
      line.textContent = '没有连上本地托盘服务。先运行 JobLedgerTray，再回来配置。' +
        (error && error.message ? '（' + error.message + '）' : '');
    }
  }

  async function saveImapSettings(test) {
    const response = await send({
      type: 'SET_IMAP_CONFIG',
      patch: Object.assign(imapPatch(), { test: Boolean(test) })
    });
    if (!response || !response.ok) throw new Error((response && response.error) || '保存邮箱配置失败');
    if (response.test && response.test.ok === false) {
      throw new Error(response.test.error || 'IMAP 测试失败');
    }
    emailServiceError = '';
    renderEmailIndicator();
    return response;
  }

  async function saveEmailSettings(options) {
    const response = await send({ type: 'SET_EMAIL_SYNC', patch: emailPatch() });
    if (!response || !response.ok) throw new Error((response && response.error) || '保存失败');
    state = response.state;
    render();
    if (!(options && options.silent)) showToast('邮件同步设置已保存');
    return response;
  }

  async function testEmailConnection() {
    const button = $('#emailTest');
    button.disabled = true;
    button.textContent = '测试中…';
    try {
      await saveEmailSettings({ silent: true });
      const response = await saveImapSettings(true);
      const test = response.test || {};
      const line = $('#emailStatus');
      line.className = 'email-status ok';
      let text = '托盘服务已连接 · IMAP 登录成功 · 文件夹：' + (test.mailbox || $('#emailImapMailbox').value || 'INBOX');
      if (test.llm) {
        if (test.llm.ok) {
          text += ' · 大模型：' + (test.llm.status || 'ok') + ' / ' + (test.llm.category || '');
        } else {
          text += ' · 大模型测试失败：' + (test.llm.error || '未知错误');
          line.className = 'email-status';
        }
      }
      line.textContent = text;
      showToast('IMAP 连接正常');
    } catch (error) {
      const line = $('#emailStatus');
      line.className = 'email-status error';
      line.textContent = error && error.message ? error.message : '连接失败';
      showToast('连接失败，请检查邮箱配置', 'error');
    } finally {
      button.disabled = false;
      button.textContent = '测试连接';
    }
  }

  async function syncEmailNow() {
    const button = $('#emailSyncNow');
    button.disabled = true;
    button.textContent = '同步中…';
    try {
      await saveEmailSettings({ silent: true });
      await saveImapSettings(false);
      const response = await send({ type: 'SYNC_EMAIL' });
      state = response.state || state;
      render();
      renderEmailStatus();
      if (!response || !response.ok) throw new Error((response && response.error) || '同步失败');
      const result = response;
      emailServiceError = '';
      renderEmailIndicator();
      showToast('同步完成：新邮件 ' + (result.imported || 0) + '，更新记录 ' + (result.updated || 0) + '，跳过 ' + (result.skipped || 0));
    } catch (error) {
      emailServiceError = error && error.message ? error.message : '同步失败';
      renderEmailIndicator();
      showToast(emailServiceError, 'error');
      renderEmailStatus();
    } finally {
      button.disabled = false;
      button.textContent = '立即同步';
    }
  }

  async function reclassifyEmails() {
    if (!window.confirm('会清空本地邮件事件和自动导入的岗位，保留手动投递，然后用当前规则/大模型重新扫描邮箱。继续？')) return;
    const button = $('#emailReclassify');
    button.disabled = true;
    button.textContent = '识别中…';
    try {
      await saveEmailSettings({ silent: true });
      await saveImapSettings(false);
      const response = await send({ type: 'RESET_EMAIL_SYNC' });
      state = response.state || state;
      render();
      renderEmailStatus();
      if (!response || !response.ok) throw new Error((response && response.error) || '重新识别失败');
      emailServiceError = '';
      renderEmailIndicator();
      showToast('重新识别完成：新增 ' + (response.imported || 0) + ' 封邮件，更新 ' + (response.updated || 0) + ' 条记录');
    } catch (error) {
      emailServiceError = error && error.message ? error.message : '重新识别失败';
      renderEmailIndicator();
      showToast(emailServiceError, 'error');
      renderEmailStatus();
    } finally {
      button.disabled = false;
      button.textContent = '重新识别邮件';
    }
  }

  async function cleanupEmailApplications() {
    if (!window.confirm('删除之前由邮件自动创建的岗位记录？手动记录的投递和邮件栏会保留。')) return;
    const button = $('#emailCleanup');
    button.disabled = true;
    button.textContent = '清理中…';
    try {
      const response = await send({ type: 'CLEAN_EMAIL_APPS' });
      if (!response || !response.ok) throw new Error((response && response.error) || '清理失败');
      state = response.state;
      render();
      showToast('已清理 ' + (response.removed || 0) + ' 条邮件自动创建的岗位');
    } catch (error) {
      showToast(error && error.message ? error.message : '清理失败', 'error');
    } finally {
      button.disabled = false;
      button.textContent = '清理旧版邮件岗位';
    }
  }

  function renderEditStatusOptions() {
    $('#editStatus').innerHTML = C.STATUSES.map((status) => {
      return '<option value="' + status.id + '">' + C.escapeHtml(status.label) + '</option>';
    }).join('');
  }

  function renderTimeline(application) {
    const timeline = $('#timeline');
    if (!application || !application.events || !application.events.length) {
      timeline.innerHTML = '<div class="timeline-empty">还没有状态变更记录。</div>';
      return;
    }
    const events = application.events.slice().sort((a, b) => new Date(a.at) - new Date(b.at));
    timeline.innerHTML = '<div class="eyebrow" style="margin-bottom:6px">状态时间线</div>' + events.map((event) => {
      const status = C.getStatus(event.status);
      return '<div class="timeline-item">' +
        '<span class="tl-dot" style="--sc:' + status.color + '"></span>' +
        '<div class="tl-body"><strong>' + C.escapeHtml(status.label) + '</strong><span>' + C.escapeHtml(C.formatDate(event.at, true)) + '</span>' +
        (event.note ? '<p class="tl-note">' + C.escapeHtml(event.note) + '</p>' : '') +
        '</div>' +
      '</div>';
    }).join('');
  }

  function openEdit(id) {
    const application = id ? state.applications.find((item) => item.id === id) : null;
    ui.editingId = application ? application.id : null;
    $('#editTitle').textContent = application ? '编辑投递' : '添加投递';
    $('#editKicker').textContent = application ? 'EDIT RECORD' : 'NEW RECORD';
    $('#deleteBtn').classList.toggle('hidden', !application);
    $('#editCompany').value = application && application.company !== '待确认' ? application.company : '';
    $('#editRole').value = application && application.role !== '待确认' ? application.role : '';
    $('#editStatus').value = application ? application.status : 'applied';
    $('#editApplied').value = C.dateInputValue(application ? (application.appliedAt || application.createdAt) : new Date());
    $('#editUrl').value = application ? application.url || '' : '';
    $('#editNotes').value = application ? application.notes || '' : '';
    $('#jdDetails').classList.toggle('hidden', !(application && application.jdText));
    $('#editJd').textContent = application && application.jdText ? application.jdText : '';
    renderTimeline(application);
    ui.previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    $('#editModal').classList.remove('hidden', 'is-closing');
    $('.modal-card').scrollTop = 0;
    setTimeout(() => $('#editCompany').focus(), 40);
  }

  function closeEdit() {
    hideModal('editModal');
    document.body.style.overflow = ui.previousOverflow || '';
    ui.editingId = null;
  }

  async function saveEdit() {
    const button = $('#saveEdit');
    const company = $('#editCompany').value.trim() || '待确认';
    const role = $('#editRole').value.trim() || '待确认';
    const url = $('#editUrl').value.trim();
    const notes = $('#editNotes').value.trim();
    const status = $('#editStatus').value;
    const appliedValue = $('#editApplied').value;
    const payload = {
      company,
      role,
      status,
      url,
      notes,
      source: C.hostOf(url),
      capture: 'manual'
    };
    if (appliedValue) payload.appliedAt = C.dateAtNoonIso(appliedValue);

    button.disabled = true;
    button.textContent = '保存中…';
    try {
      let response;
      if (ui.editingId) {
        response = await send({ type: 'UPDATE_APPLICATION', id: ui.editingId, patch: payload });
      } else {
        response = await send({ type: 'SAVE_APPLICATION', payload });
      }
      if (!response || !response.ok) throw new Error((response && response.error) || '保存失败');
      state = response.state;
      const editing = Boolean(ui.editingId);
      closeEdit();
      render();
      showToast(editing ? '已保存修改' : '已添加一条投递记录');
    } catch (error) {
      showToast(error && error.message ? error.message : '保存失败，请重试', 'error');
    } finally {
      button.disabled = false;
      button.textContent = '保存';
    }
  }

  async function updateStatus(id, status) {
    const application = state.applications.find((item) => item.id === id);
    if (!application || application.status === status) return;
    try {
      const response = await send({
        type: 'UPDATE_APPLICATION',
        id,
        patch: { status, statusNote: '从看板更新' }
      });
      if (!response || !response.ok) throw new Error((response && response.error) || '更新失败');
      state = response.state;
      render();
      showToast('已更新为「' + C.statusLabel(status) + '」');
    } catch (error) {
      showToast(error && error.message ? error.message : '更新失败', 'error');
      render();
    }
  }

  async function removeApplication(id) {
    const application = state.applications.find((item) => item.id === id);
    if (!application) return;
    if (!window.confirm('删除「' + application.company + ' · ' + application.role + '」这条记录？此操作不可撤销。')) return;
    try {
      const response = await send({ type: 'DELETE_APPLICATION', id });
      if (!response || !response.ok) throw new Error((response && response.error) || '删除失败');
      state = response.state;
      if (ui.editingId === id) closeEdit();
      render();
      showToast('已删除');
    } catch (error) {
      showToast(error && error.message ? error.message : '删除失败', 'error');
    }
  }

  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime || 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1200);
  }

  function stamp() {
    const date = new Date();
    const pad = (number) => String(number).padStart(2, '0');
    return date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate());
  }

  function exportJson() {
    if (!state.applications.length) {
      showToast('还没有可导出的记录');
      return;
    }
    download('投递簿-' + stamp() + '.json', JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      applications: state.applications,
      settings: state.settings
    }, null, 2));
    showToast('已导出 JSON 备份');
  }

  function exportCsv() {
    if (!state.applications.length) {
      showToast('还没有可导出的记录');
      return;
    }
    download('投递簿-' + stamp() + '.csv', '\ufeff' + C.toCsv(state.applications), 'text/csv;charset=utf-8');
    showToast('已导出 CSV 表格');
  }

  async function handleImport(file) {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      showToast('文件太大了（超过 2MB）', 'error');
      return;
    }
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const applications = Array.isArray(data) ? data : data.applications;
      if (!Array.isArray(applications)) throw new Error('没有找到 applications 数组');
      const response = await send({ type: 'IMPORT_STATE', applications });
      if (!response || !response.ok) throw new Error((response && response.error) || '导入失败');
      state = response.state;
      render();
      showToast('导入 ' + response.imported + ' 条，跳过 ' + response.skipped + ' 条');
    } catch (error) {
      showToast('导入失败：' + (error && error.message ? error.message : '文件格式不正确'), 'error');
    } finally {
      $('#importFile').value = '';
    }
  }

  async function clearAll() {
    if (!state.applications.length) return;
    if (!window.confirm('确定清空全部投递记录？此操作不可撤销，建议先导出 JSON 备份。')) return;
    try {
      const response = await send({ type: 'CLEAR_ALL' });
      if (!response || !response.ok) throw new Error((response && response.error) || '清空失败');
      state = response.state;
      render();
      showToast('已清空全部记录');
    } catch (error) {
      showToast(error && error.message ? error.message : '清空失败', 'error');
    }
  }

  function focusFromQuery() {
    const id = new URLSearchParams(location.search).get('focus');
    if (!id) return;
    setTimeout(() => {
      const target = document.querySelector('[data-id="' + CSS.escape(id) + '"]');
      if (!target) return;
      target.classList.add('is-focus');
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 250);
  }

  function bind() {
    $('#stats').addEventListener('click', (event) => {
      const card = event.target.closest('[data-filter]');
      if (!card) return;
      ui.filter = card.dataset.filter;
      render();
    });

    $('#filters').addEventListener('click', (event) => {
      const chip = event.target.closest('[data-filter]');
      if (!chip) return;
      ui.filter = chip.dataset.filter;
      render();
    });

    $('#search').addEventListener('input', (event) => {
      clearTimeout(searchTimer);
      const value = event.target.value;
      searchTimer = setTimeout(() => {
        ui.query = value;
        render();
      }, 140);
    });

    $('#sort').addEventListener('change', (event) => {
      ui.sort = event.target.value;
      render();
    });

    $('#viewList').addEventListener('click', () => {
      ui.view = 'list';
      localStorage.setItem('jobledger:view', ui.view);
      render();
    });
    $('#viewBoard').addEventListener('click', () => {
      ui.view = 'board';
      localStorage.setItem('jobledger:view', ui.view);
      render();
    });

    $('#addBtn').addEventListener('click', () => openEdit(null));
    $('#emptyAdd').addEventListener('click', () => openEdit(null));
    $('#importBtn').addEventListener('click', () => $('#importFile').click());
    $('#emptyImport').addEventListener('click', () => $('#importFile').click());
    $('#importFile').addEventListener('change', (event) => handleImport(event.target.files && event.target.files[0]));

    $('#exportBtn').addEventListener('click', (event) => {
      event.stopPropagation();
      $('#exportMenu').classList.toggle('hidden');
    });
    $('#exportJson').addEventListener('click', () => {
      $('#exportMenu').classList.add('hidden');
      exportJson();
    });
    $('#exportCsv').addEventListener('click', () => {
      $('#exportMenu').classList.add('hidden');
      exportCsv();
    });
    document.addEventListener('click', (event) => {
      if (!event.target.closest('.menu-wrap')) $('#exportMenu').classList.add('hidden');
    });

    $('#listView').addEventListener('change', (event) => {
      const select = event.target.closest('[data-action="status"]');
      if (select) updateStatus(select.dataset.id, select.value);
    });
    $('#listView').addEventListener('click', (event) => {
      const action = event.target.closest('[data-action]');
      if (!action) return;
      if (action.dataset.action === 'toggle-company') {
        const key = action.dataset.key;
        const expanding = !ui.expandedCompanies.has(key);
        if (expanding) ui.expandedCompanies.add(key);
        else ui.expandedCompanies.delete(key);
        const card = action.closest('.company-card');
        if (card) card.classList.toggle('is-expanded', expanding);
        action.setAttribute('aria-expanded', String(expanding));
        if (expanding) {
          send({ type: 'MARK_COMPANY_READ', company: action.dataset.companyName }).then((response) => {
            if (response && response.ok) {
              state = response.state;
              clearCompanyUnread(card);
            }
          }).catch(() => {});
        }
        return;
      }
      const id = action.dataset.id;
      if (action.dataset.action === 'edit') openEdit(id);
      if (action.dataset.action === 'delete') removeApplication(id);
    });
    $('#listView').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const header = event.target.closest('[data-action="toggle-company"]');
      if (!header) return;
      event.preventDefault();
      const key = header.dataset.key;
      const expanding = !ui.expandedCompanies.has(key);
      if (expanding) ui.expandedCompanies.add(key);
      else ui.expandedCompanies.delete(key);
      const card = header.closest('.company-card');
      if (card) card.classList.toggle('is-expanded', expanding);
      header.setAttribute('aria-expanded', String(expanding));
      if (expanding) {
        send({ type: 'MARK_COMPANY_READ', company: header.dataset.companyName }).then((response) => {
          if (response && response.ok) {
            state = response.state;
            clearCompanyUnread(card);
          }
        }).catch(() => {});
      }
    });

    $('#boardView').addEventListener('click', (event) => {
      if (event.target.closest('a')) return;
      const card = event.target.closest('.kanban-card');
      if (card && card.dataset.id) openEdit(card.dataset.id);
    });
    $('#boardView').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const card = event.target.closest('.kanban-card');
      if (card && card.dataset.id) {
        event.preventDefault();
        openEdit(card.dataset.id);
      }
    });

    $('#closeEdit').addEventListener('click', closeEdit);
    $('#cancelEdit').addEventListener('click', closeEdit);
    $('#saveEdit').addEventListener('click', saveEdit);
    $('#deleteBtn').addEventListener('click', () => {
      if (ui.editingId) removeApplication(ui.editingId);
    });
    $('#editModal').addEventListener('click', (event) => {
      if (event.target === $('#editModal')) closeEdit();
    });
    $('#clearAll').addEventListener('click', clearAll);

    $('#emailBtn').addEventListener('click', openEmailModal);
    $('#closeEmail').addEventListener('click', closeEmailModal);
    $('#emailCancel').addEventListener('click', closeEmailModal);
    $('#emailModal').addEventListener('click', (event) => {
      if (event.target === $('#emailModal')) closeEmailModal();
    });
    $('#emailSave').addEventListener('click', async () => {
      try {
        const firstSync = $('#emailEnabled').checked && !emailConfig().lastSyncAt;
        await saveEmailSettings({ silent: true });
        await saveImapSettings(false);
        closeEmailModal();
        showToast(firstSync ? '配置已保存，正在读取历史邮件…' : '邮箱配置已保存');
        if (firstSync) {
          const response = await send({ type: 'SYNC_EMAIL' });
          state = response.state || state;
          render();
          if (!response || !response.ok) throw new Error((response && response.error) || '首次同步失败');
          showToast('历史邮件读取完成：新邮件 ' + (response.imported || 0) + '，更新记录 ' + (response.updated || 0));
        }
      } catch (error) {
        showToast(error && error.message ? error.message : '保存失败', 'error');
      }
    });
    $('#emailTest').addEventListener('click', testEmailConnection);
    $('#emailSyncNow').addEventListener('click', syncEmailNow);
    $('#emailReclassify').addEventListener('click', reclassifyEmails);
    $('#emailCleanup').addEventListener('click', cleanupEmailApplications);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !$('#emailModal').classList.contains('hidden')) closeEmailModal();
      if (event.key === 'Escape' && !$('#editModal').classList.contains('hidden')) closeEdit();
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        $('#search').focus();
      }
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes.jobledger || !changes.jobledger.newValue) return;
      state = changes.jobledger.newValue;
      render();
    });
  }

  async function init() {
    renderEditStatusOptions();
    bind();
    try {
      const response = await send({ type: 'GET_STATE' });
      if (response && response.ok && response.state) state = response.state;
    } catch (error) {
      showToast('读取本地数据失败：' + (error && error.message ? error.message : '未知错误'), 'error');
    }
    render();
    focusFromQuery();
    if (new URLSearchParams(location.search).has('welcome')) {
      showToast('先打开一个招聘页，点右下角「记投递」；也可以手动添加一条。');
    }
  }

  init();
})();
