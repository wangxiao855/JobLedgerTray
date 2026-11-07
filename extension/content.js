/* global JobLedgerCore */
(function () {
  'use strict';

  if (window.__jobLedgerLoaded) return;
  window.__jobLedgerLoaded = true;

  const C = window.JobLedgerCore;
  const CACHE_KEY = 'jobledger:lastJob';
  const SUCCESS_SEEN = new Set();

  const ATS_DOMAINS = [
    'mokahr.com', 'moka.com', 'zhiye.com', 'hotjob.cn', '51job.com', 'zhaopin.com',
    'zhipin.com', 'liepin.com', 'lagou.com', 'nowcoder.com', 'shixiseng.com',
    'yingjiesheng.com', 'dajie.com', 'wjx.cn', 'jinshuju.net', 'docs.qq.com',
    'feishu.cn', 'larksuite.com', 'workday.com', 'myworkdayjobs.com',
    'greenhouse.io', 'lever.co', 'smartrecruiters.com', 'icims.com', 'taleo.net',
    'successfactors.com', 'beisen.com', 'italent.cn', 'dayee.com', 'gllue.com'
  ];

  const ATS_BRANDS = /^(moka|mokahr|北森|beisen|智联|前程无忧|boss直聘|猎聘|拉勾|牛客|实习僧|workday|greenhouse|lever|smartrecruiters|icims|taleo|successfactors|问卷星|金数据|飞书|腾讯文档)$/i;

  const JOB_PATH_RE = /(^|\/)(jobs?|careers?|positions?|recruit(ing)?|zhaopin|campus|talent|apply|joinus|job-detail|jobdetail|vacanc(y|ies))(\/|$)/i;
  const SUCCESS_PATH_RE = /(success|complete|thank|applied|submitted)/i;

  let ui = null;
  let modalOpen = false;
  let scanTimer = null;
  let observer = null;
  let lastUrl = location.href;
  let lastJobUrl = '';

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

  function metaContent() {
    const names = Array.from(arguments);
    for (const name of names) {
      const element = document.querySelector('meta[property="' + name + '"], meta[name="' + name + '"]');
      if (element && element.content) return element.content.trim();
    }
    return '';
  }

  function jsonLdNodes() {
    const nodes = [];
    const visited = new Set();
    function walk(value) {
      if (!value || typeof value !== 'object' || visited.has(value)) return;
      visited.add(value);
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      nodes.push(value);
      if (value['@graph']) walk(value['@graph']);
    }
    document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
      try {
        walk(JSON.parse(script.textContent));
      } catch (error) {
        /* ignore malformed JSON-LD */
      }
    });
    return nodes;
  }

  function hasType(node, type) {
    const nodeType = node && node['@type'];
    return Array.isArray(nodeType) ? nodeType.includes(type) : nodeType === type;
  }

  function isVisible(element) {
    if (!element || !element.getBoundingClientRect) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function firstText(selectors) {
    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector);
      for (const element of elements) {
        if (!isVisible(element)) continue;
        const text = C.cleanText(element.innerText || element.textContent || '');
        if (text.length >= 2 && text.length <= 100) return text;
      }
    }
    return '';
  }

  function isAtsHost(host) {
    const value = String(host || '').toLowerCase();
    return ATS_DOMAINS.some((domain) => value === domain || value.endsWith('.' + domain));
  }

  function isCareerHost(host) {
    return /^(jobs|job|careers?|campus|zhaopin|recruit|talent|apply|joinus)\./i.test(String(host || ''));
  }

  function cleanCompany(value) {
    let text = C.cleanText(value);
    text = text.replace(/[（(][^）)]{0,20}[）)]\s*$/g, '');
    text = text.replace(/(招聘官网|校园招聘|社会招聘|招聘|官网|首页|主页)\s*$/g, '');
    text = text.replace(/\s*logo\s*$/i, '');
    text = text.replace(/^欢迎来到\s*/, '').trim();
    if (!text || text.length < 2 || text.length > 40) return '';
    if (ATS_BRANDS.test(text)) return '';
    if (/^(职位|岗位|首页|登录|注册|搜索|更多|加入我们)$/.test(text)) return '';
    return text;
  }

  function cleanRole(value) {
    let text = C.cleanText(value)
      .replace(/^(职位|岗位)\s*[:：]\s*/, '')
      .replace(/\s*[-|｜]\s*(招聘|职位详情|岗位详情).*$/g, '')
      .trim();
    if (text.length > 100) text = text.slice(0, 100);
    if (!text || /^(加入我们|人才招聘|校园招聘|社会招聘|招聘|职位列表|全部职位|首页)$/.test(text)) return '';
    return text;
  }

  function findJobPosting(nodes) {
    return nodes.find((node) => hasType(node, 'JobPosting')) || null;
  }

  function findCompany(nodes) {
    const job = findJobPosting(nodes);
    let company = '';
    if (job) {
      const organization = job.hiringOrganization;
      if (typeof organization === 'string') company = organization;
      else if (organization && organization.name) company = organization.name;
    }
    if (!company) {
      const organization = nodes.find((node) => hasType(node, 'Organization') && node.name);
      if (organization) company = organization.name;
    }
    if (!company) company = metaContent('og:site_name', 'application-name', 'apple-mobile-web-app-title');
    if (!company) {
      const logo = document.querySelector('header img[alt], [class*="logo"] img[alt], [class*="brand"] img[alt], a[class*="logo"] img[alt]');
      if (logo && logo.alt) company = logo.alt;
    }
    if (!company) {
      company = firstText([
        '[class*="company-name"]', '[class*="companyName"]', '[class*="corp-name"]',
        '[class*="corpName"]', '[class*="brand-name"]', '[class*="brandName"]'
      ]);
    }
    if (!company) company = C.pickCompanyFromTitle(document.title);
    if (!company && !isAtsHost(location.hostname)) {
      company = C.guessCompanyFromHost(location.hostname);
    }
    return cleanCompany(company) || '待确认';
  }

  function findRole(nodes, company) {
    const job = findJobPosting(nodes);
    let role = job && job.title ? job.title : '';
    if (!role) {
      role = firstText([
        'h1', '[class*="job-title"]', '[class*="jobTitle"]', '[class*="position-title"]',
        '[class*="positionTitle"]', '[class*="job-name"]', '[class*="jobName"]'
      ]);
    }
    if (!role || role === company) role = C.pickRoleFromTitle(document.title, company);
    if (!role) role = C.pickRoleFromTitle(metaContent('og:title'), company);
    return cleanRole(role) || '待确认';
  }

  function findLocation(nodes, text) {
    const job = findJobPosting(nodes);
    if (job && job.jobLocation) {
      const location = Array.isArray(job.jobLocation) ? job.jobLocation[0] : job.jobLocation;
      if (typeof location === 'string') return C.cleanText(location).slice(0, 80);
      if (location && location.address) {
        const address = location.address;
        const value = address.addressLocality || address.addressRegion || address.name;
        if (value) return C.cleanText(value).slice(0, 80);
      }
    }
    const match = String(text || '').match(/(?:工作地点|办公地点|职位地点|地点)\s*[:：]\s*([^\n|｜]{2,30})/);
    return match ? C.cleanText(match[1]).slice(0, 80) : '';
  }

  function findSalary(text) {
    const match = String(text || '').match(/(?:薪资|月薪|年薪|薪酬|待遇)\s*[:：]\s*([0-9０-９][0-9０-９.万千kKwW\-~—–至\/月年元天]{0,24})/);
    return match ? C.cleanText(match[1]).slice(0, 80) : '';
  }

  function findJdText(text) {
    const selectors = [
      '[class*="job-detail"]', '[class*="jobDetail"]', '[class*="position-detail"]',
      '[class*="job-description"]', '[class*="jobDescription"]', '[class*="description"]',
      'main', 'article'
    ];
    let best = '';
    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach((element) => {
        const value = C.cleanText(element.innerText || '');
        if (value.length > best.length && value.length < 20000) best = value;
      });
    }
    if (best.length < 100) best = C.cleanText(text || '');
    return best.slice(0, 3000);
  }

  function sampleText(limit) {
    if (!document.body) return '';
    return C.cleanText(document.body.innerText || '').slice(0, limit || 30000);
  }

  function looksLikeJobPage(text) {
    const host = location.hostname;
    const path = location.pathname + location.search;
    if (JOB_PATH_RE.test(path)) return true;
    if (isAtsHost(host) && (C.isJobText(text) || /job|position|apply/i.test(path))) return true;
    if (isCareerHost(host)) return true;
    return C.isJobText(text);
  }

  function looksLikeSuccess(text) {
    if (!C.isSuccessText(text)) return false;
    const host = location.hostname;
    const path = location.pathname + location.search;
    if (isAtsHost(host) || JOB_PATH_RE.test(path) || SUCCESS_PATH_RE.test(path)) return true;
    if (document.referrer) {
      try {
        const referrer = new URL(document.referrer);
        if (JOB_PATH_RE.test(referrer.pathname) || isAtsHost(referrer.hostname)) return true;
      } catch (error) {
        /* ignore */
      }
    }
    return true;
  }

  function rememberLastJob(info) {
    if (!info || (info.company === '待确认' && info.role === '待确认')) return;
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({
        host: location.hostname,
        company: info.company,
        role: info.role,
        location: info.location,
        salary: info.salary,
        pageTitle: info.pageTitle,
        jdText: info.jdText
      }));
    } catch (error) {
      /* storage can be unavailable */
    }
  }

  function readLastJob() {
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  }

  function extractPageInfo(text) {
    const bodyText = typeof text === 'string' ? text : sampleText();
    const nodes = jsonLdNodes();
    const company = findCompany(nodes);
    const role = findRole(nodes, company);
    const detection = looksLikeSuccess(bodyText) ? 'success' : (looksLikeJobPage(bodyText) ? 'job' : 'unknown');
    const info = {
      company,
      role,
      status: 'applied',
      url: location.href,
      source: location.hostname.replace(/^www\./i, ''),
      pageTitle: C.truncate(document.title, 160),
      location: findLocation(nodes, bodyText),
      salary: findSalary(bodyText),
      jdText: findJdText(bodyText),
      capturedAt: new Date().toISOString(),
      detection
    };

    if (detection === 'success') {
      const cached = readLastJob();
      if (cached && (cached.host === location.hostname || info.company === '待确认')) {
        if (info.company === '待确认' && cached.company) info.company = cached.company;
        if (info.role === '待确认' && cached.role) info.role = cached.role;
        if (!info.location && cached.location) info.location = cached.location;
        if (!info.salary && cached.salary) info.salary = cached.salary;
        if (cached.jdText && (!info.jdText || info.jdText.length < 100)) info.jdText = cached.jdText;
      }
    }

    if (detection === 'job') rememberLastJob(info);
    return info;
  }

  function uiStyles() {
    return `
      :host { all: initial; }
      *, *::before, *::after { box-sizing: border-box; }
      [hidden] { display: none !important; }
      .jl-launcher {
        position: fixed; right: 22px; bottom: 22px; z-index: 2147483646;
        display: flex; align-items: center; gap: 8px;
        padding: 8px 14px 8px 8px; border-radius: 999px;
        border: 1px solid rgba(255,255,255,.14);
        background: #0a0a0a; color: #fff; cursor: pointer;
        box-shadow: 0 10px 24px rgba(10,10,10,.18), 0 2px 6px rgba(10,10,10,.12);
        font: 600 13px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
        letter-spacing: .01em; transition: transform .16s ease, box-shadow .16s ease;
      }
      .jl-launcher:hover { transform: translateY(-1px); box-shadow: 0 16px 34px rgba(15,23,42,.34); }
      .jl-launcher:active { transform: translateY(0); }
      .jl-launcher.is-success { background: #0a0a0a; }
      .jl-mark {
        width: 22px; height: 22px; border-radius: 7px; display: grid; place-items: center;
        background: #fff; color: #0a0a0a;
        font-size: 12px; font-weight: 800; line-height: 1;
      }
      .jl-toast {
        position: fixed; right: 22px; bottom: 76px; z-index: 2147483646;
        width: 310px; max-width: calc(100vw - 44px);
        padding: 14px; border-radius: 14px; background: #fff; color: #0f172a;
        border: 1px solid #e2e8f0; box-shadow: 0 18px 40px rgba(15,23,42,.22);
        font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
        animation: jl-rise .2s ease-out;
      }
      .jl-toast-title { display: flex; align-items: center; gap: 8px; font-weight: 700; margin-bottom: 4px; }
      .jl-toast-title span:first-child { width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; background: #dcfce7; color: #15803d; font-size: 11px; }
      .jl-toast p { margin: 0; color: #475569; }
      .jl-toast-actions { display: flex; gap: 8px; margin-top: 11px; }
      .jl-btn {
        appearance: none; border: 1px solid #e2e8f0; background: #f8fafc; color: #0f172a;
        border-radius: 9px; padding: 7px 12px; cursor: pointer;
        font: 600 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      }
      .jl-btn:hover { background: #f1f5f9; }
      .jl-btn.primary { background: #0a0a0a; border-color: #0a0a0a; color: #fff; }
      .jl-btn.primary:hover { background: #262626; border-color: #262626; }
      .jl-btn.ghost { background: transparent; }
      .jl-overlay {
        position: fixed; inset: 0; z-index: 2147483647; padding: 18px;
        display: flex; align-items: center; justify-content: center;
        background: rgba(10,10,10,.36); backdrop-filter: none;
        animation: jl-fade .16s ease-out;
        font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      }
      .jl-overlay.jl-closing { animation: jl-fade-out .16s ease-in forwards; }
      .jl-overlay.jl-closing .jl-modal { animation: jl-modal-out .16s ease-in forwards; }
      @keyframes jl-fade-out { from { opacity: 1; } to { opacity: 0; } }
      @keyframes jl-modal-out { from { opacity: 1; transform: translateY(0) scale(1); } to { opacity: 0; transform: translateY(6px) scale(.99); } }
      .jl-modal {
        width: min(480px, 100%); max-height: 90vh; overflow: auto;
        border: 1px solid #e5e5e5; border-radius: 16px; background: #fff; color: #0a0a0a;
        box-shadow: 0 24px 60px rgba(10,10,10,.16);
        animation: jl-rise .2s ease-out;
      }
      .jl-head {
        position: relative; padding: 20px 22px 16px;
        border-bottom: 1px solid #e5e5e5; background: #fff; color: #0a0a0a;
      }
      .jl-kicker { font-size: 9px; font-weight: 650; letter-spacing: .16em; color: #737373; text-transform: uppercase; }
      .jl-head h2 { margin: 5px 0 4px; font-size: 20px; line-height: 1.3; letter-spacing: -.02em; }
      .jl-head p { margin: 0; color: #737373; font-size: 11px; line-height: 1.45; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .jl-close {
        position: absolute; top: 14px; right: 14px; width: 30px; height: 30px;
        border: 1px solid #e5e5e5; border-radius: 7px; background: #fff; color: #737373;
        font-size: 18px; line-height: 1; cursor: pointer;
      }
      .jl-close:hover { background: #fafafa; color: #0a0a0a; }
      .jl-body { padding: 18px 22px 20px; }
      .jl-field { margin-bottom: 12px; }
      .jl-field label { display: block; margin-bottom: 6px; color: #737373; font-size: 9px; font-weight: 650; letter-spacing: .08em; text-transform: uppercase; }
      .jl-field input, .jl-field select, .jl-field textarea {
        width: 100%; border: 1px solid #e5e5e5; border-radius: 8px;
        padding: 10px 12px; background: #fafafa; color: #0a0a0a;
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        outline: none; transition: border-color .15s ease, box-shadow .15s ease;
      }
      .jl-field input:focus, .jl-field select:focus, .jl-field textarea:focus {
        border-color: #0a0a0a; box-shadow: 0 0 0 2px rgba(10,10,10,.06); background: #fff;
      }
      .jl-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      .jl-url {
        margin: 2px 0 4px; padding: 8px 10px; border-radius: 8px;
        background: #f8fafc; border: 1px solid #f1f5f9;
        color: #64748b; font-size: 10px; line-height: 1.45; word-break: break-all;
      }
      .jl-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 16px; }
      .jl-actions > div { display: flex; gap: 8px; }
      .jl-footnote { color: #94a3b8; font-size: 10px; }
      .jl-error { min-height: 16px; margin: 10px 0 0; color: #b91c1c; font-size: 11px; }
      .jl-success { padding: 34px 24px 26px; text-align: center; }
      .jl-success-icon {
        width: 56px; height: 56px; margin: 0 auto 14px; border-radius: 50%;
        display: grid; place-items: center; background: #dcfce7; color: #15803d;
        font-size: 26px; font-weight: 800;
      }
      .jl-success h3 { margin: 0 0 6px; font-size: 20px; }
      .jl-success p { margin: 0 0 4px; color: #475569; }
      .jl-success .jl-actions { justify-content: center; margin-top: 20px; }
      @keyframes jl-rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes jl-fade { from { opacity: 0; } to { opacity: 1; } }
      @media (max-width: 520px) {
        .jl-launcher { right: 14px; bottom: 14px; }
        .jl-toast { right: 14px; bottom: 68px; }
        .jl-overlay { padding: 12px; align-items: flex-end; }
        .jl-modal { border-radius: 16px; max-height: 92vh; }
      }
    `;
  }

  function ensureUi() {
    if (ui && document.documentElement.contains(ui.host)) return ui;
    const host = document.createElement('div');
    host.id = 'jobledger-root';
    host.style.cssText = 'all: initial; position: fixed; inset: auto 0 0 auto; width: 0; height: 0; z-index: 2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>${uiStyles()}</style>
      <div class="jl-toast" id="jl-toast" hidden></div>
      <button class="jl-launcher" id="jl-launcher" type="button" aria-label="记录这次投递">
        <span class="jl-mark">投</span><span>记投递</span>
      </button>
      <div id="jl-modal-root"></div>
    `;
    (document.body || document.documentElement).appendChild(host);
    ui = {
      host,
      shadow,
      launcher: shadow.getElementById('jl-launcher'),
      toast: shadow.getElementById('jl-toast'),
      modalRoot: shadow.getElementById('jl-modal-root'),
      toastTimer: null
    };
    ui.launcher.addEventListener('click', () => {
      hideToast();
      openModal(extractPageInfo());
    });
    return ui;
  }

  function showToast(options) {
    ensureUi();
    const toast = ui.toast;
    clearTimeout(ui.toastTimer);
    toast.innerHTML = `
      <div class="jl-toast-title"><span>✓</span><span>${C.escapeHtml(options.title || '记录成功')}</span></div>
      <p>${C.escapeHtml(options.message || '')}</p>
      <div class="jl-toast-actions">
        <button class="jl-btn primary" id="jl-toast-action" type="button">${C.escapeHtml(options.action || '记录')}</button>
        <button class="jl-btn ghost" id="jl-toast-dismiss" type="button">稍后</button>
      </div>
    `;
    toast.hidden = false;
    const action = toast.querySelector('#jl-toast-action');
    const dismiss = toast.querySelector('#jl-toast-dismiss');
    action.addEventListener('click', () => {
      hideToast();
      if (typeof options.onAction === 'function') options.onAction();
    });
    dismiss.addEventListener('click', hideToast);
    ui.toastTimer = setTimeout(hideToast, options.duration || 12000);
  }

  function hideToast() {
    if (!ui) return;
    clearTimeout(ui.toastTimer);
    ui.toast.hidden = true;
  }

  function showSuccessToast() {
    const cached = readLastJob();
    const detail = cached && cached.company !== '待确认'
      ? cached.company + ' · ' + cached.role
      : '这个页面看起来是投递成功页';
    showToast({
      title: '看起来投递成功了',
      message: detail,
      action: '记一笔',
      duration: 15000,
      onAction: () => openModal(extractPageInfo())
    });
    if (ui) ui.launcher.classList.add('is-success');
  }

  function openModal(info) {
    if (modalOpen) return;
    modalOpen = true;
    ensureUi();
    const overlay = document.createElement('div');
    overlay.className = 'jl-overlay';
    const statusOptions = C.STATUSES.map((status) => {
      return '<option value="' + status.id + '"' + (status.id === 'applied' ? ' selected' : '') + '>' + C.escapeHtml(status.label) + '</option>';
    }).join('');

    overlay.innerHTML = `
      <div class="jl-modal" role="dialog" aria-modal="true" aria-labelledby="jl-title">
        <div class="jl-head">
          <div class="jl-kicker">JobLedger · 投递簿</div>
          <h2 id="jl-title">记录这次投递</h2>
          <p>${C.escapeHtml(C.truncate(info.pageTitle || info.url, 90))}</p>
          <button class="jl-close" id="jl-close" type="button" aria-label="关闭">×</button>
        </div>
        <div class="jl-body" id="jl-body">
          <div class="jl-field">
            <label for="jl-company">公司</label>
            <input id="jl-company" type="text" maxlength="80" placeholder="例如：星河科技" autocomplete="off">
          </div>
          <div class="jl-field">
            <label for="jl-role">岗位</label>
            <input id="jl-role" type="text" maxlength="120" placeholder="例如：前端工程师" autocomplete="off">
          </div>
          <div class="jl-row">
            <div class="jl-field">
              <label for="jl-status">状态</label>
              <select id="jl-status">${statusOptions}</select>
            </div>
            <div class="jl-field">
              <label for="jl-notes">备注</label>
              <input id="jl-notes" type="text" maxlength="200" placeholder="可选，例如：内推" autocomplete="off">
            </div>
          </div>
          <div class="jl-url">${C.escapeHtml(C.truncate(info.url, 180))}</div>
          <div class="jl-actions">
            <span class="jl-footnote">数据只保存在本机 · 不联网</span>
            <div>
              <button class="jl-btn ghost" id="jl-cancel" type="button">取消</button>
              <button class="jl-btn primary" id="jl-save" type="button">保存</button>
            </div>
          </div>
          <p class="jl-error" id="jl-error" role="alert"></p>
        </div>
      </div>
    `;

    ui.modalRoot.appendChild(overlay);
    const companyInput = overlay.querySelector('#jl-company');
    const roleInput = overlay.querySelector('#jl-role');
    const statusInput = overlay.querySelector('#jl-status');
    const notesInput = overlay.querySelector('#jl-notes');
    const errorLine = overlay.querySelector('#jl-error');
    const saveButton = overlay.querySelector('#jl-save');

    companyInput.value = info.company === '待确认' ? '' : info.company;
    roleInput.value = info.role === '待确认' ? '' : info.role;
    const previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';

    function close() {
      if (!overlay.isConnected || overlay.classList.contains('jl-closing')) return;
      overlay.classList.add('jl-closing');
      modalOpen = false;
      document.documentElement.style.overflow = previousOverflow;
      setTimeout(() => overlay.remove(), 160);
      document.removeEventListener('keydown', onKeydown, true);
    }

    function onKeydown(event) {
      if (event.key === 'Escape') close();
    }

    function showError(message) {
      errorLine.textContent = message;
    }

    function showSuccess(response) {
      const application = response.application;
      const title = response.duplicate ? '已更新记录' : '已记入投递簿';
      const modal = overlay.querySelector('.jl-modal');
      modal.innerHTML = `
        <div class="jl-success">
          <div class="jl-success-icon">✓</div>
          <h3>${C.escapeHtml(title)}</h3>
          <p>${C.escapeHtml(application.company)} · ${C.escapeHtml(application.role)}</p>
          <p class="jl-footnote">今天已记录 ${response.todayCount || 1} 家</p>
          <div class="jl-actions">
            <button class="jl-btn primary" id="jl-open" type="button">打开看板</button>
            <button class="jl-btn ghost" id="jl-done" type="button">关闭</button>
          </div>
        </div>
      `;
      modal.querySelector('#jl-open').addEventListener('click', () => {
        send({ type: 'OPEN_DASHBOARD', focus: application.id }).catch(() => {});
      });
      modal.querySelector('#jl-done').addEventListener('click', close);
    }

    saveButton.addEventListener('click', async () => {
      const company = companyInput.value.trim() || '待确认';
      const role = roleInput.value.trim() || '待确认';
      const status = statusInput.value;
      const notes = notesInput.value.trim();
      if (company === '待确认' && role === '待确认') {
        showError('至少填一下公司或岗位，之后才好找。');
        companyInput.focus();
        return;
      }
      saveButton.disabled = true;
      saveButton.textContent = '保存中…';
      showError('');
      try {
        const response = await send({
          type: 'SAVE_APPLICATION',
          payload: Object.assign({}, info, {
            company,
            role,
            status,
            notes,
            capture: 'content'
          })
        });
        if (!response || !response.ok) throw new Error((response && response.error) || '保存失败');
        showSuccess(response);
      } catch (error) {
        saveButton.disabled = false;
        saveButton.textContent = '保存';
        showError(error && error.message ? error.message : '保存失败，请重试');
      }
    });

    overlay.querySelector('#jl-close').addEventListener('click', close);
    overlay.querySelector('#jl-cancel').addEventListener('click', close);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close();
    });
    document.addEventListener('keydown', onKeydown, true);
    companyInput.focus();
    companyInput.select();
  }

  function startObserver() {
    if (observer || !document.documentElement) return;
    observer = new MutationObserver(() => {
      if (modalOpen) return;
      scheduleScan(1400);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function scheduleScan(delay) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, typeof delay === 'number' ? delay : 900);
  }

  function scan() {
    if (!document.body || modalOpen) return;
    const text = sampleText(30000);
    const job = looksLikeJobPage(text);
    const success = looksLikeSuccess(text);

    if (!job && !success) {
      if (ui) ui.launcher.hidden = true;
      return;
    }

    ensureUi();
    ui.launcher.hidden = false;
    if (success) {
      ui.launcher.classList.add('is-success');
      if (!SUCCESS_SEEN.has(location.href)) {
        SUCCESS_SEEN.add(location.href);
        showSuccessToast();
      }
      startObserver();
      return;
    }

    ui.launcher.classList.remove('is-success');
    if (job) {
      if (lastJobUrl !== location.href) {
        lastJobUrl = location.href;
        rememberLastJob(extractPageInfo(text));
      }
      startObserver();
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false;
    if (message.type === 'EXTRACT_PAGE') {
      try {
        sendResponse(extractPageInfo());
      } catch (error) {
        sendResponse({
          company: '待确认',
          role: C.pickRoleFromTitle(document.title),
          status: 'applied',
          url: location.href,
          source: location.hostname,
          pageTitle: document.title,
          detection: 'unknown'
        });
      }
      return false;
    }
    if (message.type === 'OPEN_RECORD_MODAL') {
      hideToast();
      openModal(extractPageInfo());
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      scheduleScan(700);
    }
  }, 1000);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => scheduleScan(900), { once: true });
  } else {
    scheduleScan(900);
  }
})();
