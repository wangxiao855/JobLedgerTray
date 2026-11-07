/*
 * 投递簿 · shared core
 * UMD: works in content scripts, extension pages, the service worker and Node tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.JobLedgerCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STATUSES = [
    { id: 'applied', label: '已投递', short: '已投', group: 'active', color: '#475569', bg: '#f1f5f9' },
    { id: 'screening', label: '简历筛选中', short: '筛选', group: 'active', color: '#2563eb', bg: '#eff6ff' },
    { id: 'assessment', label: '测评', short: '测评', group: 'active', color: '#7c3aed', bg: '#f5f3ff' },
    { id: 'written', label: '笔试', short: '笔试', group: 'active', color: '#d97706', bg: '#fffbeb' },
    { id: 'interview1', label: '一面', short: '一面', group: 'interview', color: '#0891b2', bg: '#ecfeff' },
    { id: 'interview2', label: '二面', short: '二面', group: 'interview', color: '#0d9488', bg: '#f0fdfa' },
    { id: 'interview3', label: '三面', short: '三面', group: 'interview', color: '#059669', bg: '#ecfdf5' },
    { id: 'hr', label: 'HR 面', short: 'HR 面', group: 'interview', color: '#16a34a', bg: '#f0fdf4' },
    { id: 'offer', label: 'Offer', short: 'Offer', group: 'won', color: '#15803d', bg: '#dcfce7' },
    { id: 'rejected', label: '未通过', short: '未通过', group: 'closed', color: '#b91c1c', bg: '#fef2f2' },
    { id: 'ghosted', label: '无回复', short: '无回复', group: 'closed', color: '#6b7280', bg: '#f3f4f6' }
  ];

  const STATUS_MAP = Object.fromEntries(STATUSES.map((item) => [item.id, item]));
  const ACTIVE_GROUPS = new Set(['active', 'interview']);
  const INTERVIEW_IDS = new Set(['interview1', 'interview2', 'interview3', 'hr']);
  const AVATAR_COLORS = ['#0f766e', '#0369a1', '#6d28d9', '#b45309', '#be123c', '#4d7c0f', '#0e7490', '#7e22ce'];

  function getStatus(id) {
    return STATUS_MAP[id] || STATUS_MAP.applied;
  }

  function statusLabel(id) {
    return getStatus(id).label;
  }

  function isActive(id) {
    return ACTIVE_GROUPS.has(getStatus(id).group);
  }

  function isInterview(id) {
    return INTERVIEW_IDS.has(id);
  }

  function isClosed(id) {
    return getStatus(id).group === 'closed';
  }

  function isOffer(id) {
    return id === 'offer';
  }

  function toDate(value) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function daysSince(value, now) {
    const date = toDate(value);
    if (!date) return 0;
    const current = typeof now === 'number' ? now : Date.now();
    return Math.max(0, Math.floor((current - date.getTime()) / 86400000));
  }

  function needsFollowUp(application, days, now) {
    if (!application) return false;
    const windowDays = typeof days === 'number' ? days : 7;
    if (!isActive(application.status)) return false;
    return daysSince(application.updatedAt || application.createdAt || application.appliedAt, now) >= windowDays;
  }

  function formatDate(value, withTime) {
    const date = toDate(value);
    if (!date) return '—';
    const pad = (number) => String(number).padStart(2, '0');
    const day = date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
    return withTime ? day + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) : day;
  }

  function relativeDay(value, now) {
    const days = daysSince(value, now);
    if (days === 0) return '今天';
    if (days === 1) return '昨天';
    if (days < 7) return days + ' 天前';
    if (days < 30) return Math.floor(days / 7) + ' 周前';
    if (days < 365) return Math.floor(days / 30) + ' 个月前';
    return Math.floor(days / 365) + ' 年前';
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function cleanText(value) {
    return String(value == null ? '' : value)
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function truncate(value, max) {
    const limit = typeof max === 'number' ? max : 120;
    const text = cleanText(value).replace(/\s+/g, ' ');
    return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
  }

  function normalizeUrl(url) {
    try {
      const parsed = new URL(String(url || ''));
      parsed.hash = '';
      const keys = Array.from(parsed.searchParams.keys());
      keys.forEach((key) => {
        if (/^(utm_|gclid$|fbclid$|spm$|scm$|share_|ref$)/i.test(key)) {
          parsed.searchParams.delete(key);
        }
      });
      if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
        parsed.pathname = parsed.pathname.replace(/\/+$/, '');
      }
      return parsed.toString();
    } catch (error) {
      return String(url || '').trim();
    }
  }

  function isHttpUrl(url) {
    return /^https?:\/\//i.test(String(url || ''));
  }

  function hostOf(url) {
    try {
      return new URL(String(url || '')).hostname.replace(/^www\./i, '');
    } catch (error) {
      return '';
    }
  }

  function guessCompanyFromHost(host) {
    if (!host) return '';
    const parts = String(host).replace(/^www\./i, '').split('.');
    if (parts.length < 2) return parts[0] || '';
    const prefixes = new Set([
      'jobs', 'job', 'careers', 'career', 'campus', 'hr', 'recruit', 'recruiting',
      'talent', 'zhaopin', 'apply', 'join', 'joinus', 'home', 'www'
    ]);
    let index = 0;
    while (index < parts.length - 2 && prefixes.has(parts[index].toLowerCase())) {
      index += 1;
    }
    const name = parts[index] || parts[0];
    return name
      .replace(/[-_]+/g, ' ')
      .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
  }

  function splitTitle(title) {
    return cleanText(title)
      .split(/\s*[|｜\-–—_·•]\s*/)
      .map((part) => part.trim())
      .filter(Boolean);
  }

  function stripCompanySuffix(value) {
    return cleanText(value)
      .replace(/[（(][^）)]{0,20}[）)]\s*$/g, '')
      .replace(/(招聘官网|校园招聘|社会招聘|招聘|官网|首页|主页)\s*$/g, '')
      .trim();
  }

  function pickCompanyFromTitle(title) {
    const parts = splitTitle(title).map(stripCompanySuffix);
    const bad = /(招聘|职位|岗位|详情|申请|投递|官网|首页|校园|社会|实习|全职|兼职|Job|Careers?|Apply)/i;
    const role = /(工程师|经理|专员|主管|助理|实习|设计师|运营|产品|销售|客服|会计|财务|人力|行政|法务|编辑|记者|教师|医生|护士|司机|店长|顾问|分析师|研究员|开发|算法)/i;
    const good = /(公司|集团|科技|银行|证券|保险|大学|学院|研究院|事务所|工作室|中心|医院|汽车|地产|教育|网络|信息|数据|智能|传媒|文化|电商|物流|医药|生物|能源|制造|电子|通信|软件)/;
    const candidates = parts.filter((part) => {
      return part.length >= 2 && part.length <= 32 && !bad.test(part) && !role.test(part);
    });
    return candidates.find((part) => good.test(part)) || candidates[0] || '';
  }

  function pickRoleFromTitle(title, company) {
    const parts = splitTitle(title);
    const bad = /(招聘|官网|首页|职位详情|岗位详情|申请|投递|校园招聘|社会招聘)/i;
    const candidates = parts.filter((part) => part && part !== company && !bad.test(part));
    return candidates.sort((a, b) => b.length - a.length)[0] || '';
  }

  function isJobText(text) {
    const value = String(text || '');
    const strong = /(投递简历|申请职位|立即投递|上传简历|简历投递|我要投递|职位描述|岗位职责|任职要求|招聘流程|岗位要求)/;
    const weakMatches = value.match(/(招聘|职位|岗位|薪资|工作地点|福利|任职资格|岗位要求)/g) || [];
    return strong.test(value) || weakMatches.length >= 3;
  }

  function isSuccessText(text) {
    const value = String(text || '');
    const success = /(投递成功|申请成功|简历投递成功|已成功投递|报名成功|已收到您的简历|简历已收到|感谢您的投递|提交成功)/;
    const context = /(简历|投递|申请|招聘|职位|岗位)/;
    return success.test(value) && context.test(value);
  }

  function initials(value) {
    const chars = Array.from(String(value || '').trim());
    return chars.slice(0, 1).join('') || '?';
  }

  function colorFor(value) {
    const text = String(value || '');
    let hash = 0;
    for (let index = 0; index < text.length; index += 1) {
      hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
    }
    return AVATAR_COLORS[hash % AVATAR_COLORS.length];
  }

  function uid() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return 'app_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  }

  function dateInputValue(value) {
    const date = toDate(value);
    if (!date) return '';
    const pad = (number) => String(number).padStart(2, '0');
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  }

  function dateAtNoonIso(value) {
    if (!value) return new Date().toISOString();
    const date = new Date(String(value) + 'T12:00:00');
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  }

  function csvEscape(value) {
    const text = String(value == null ? '' : value).replace(/\r?\n/g, ' ');
    return '"' + text.replace(/"/g, '""') + '"';
  }

  function toCsv(applications) {
    const header = ['公司', '岗位', '状态', '投递日期', '最近更新', '来源', '链接', '备注'];
    const rows = (applications || []).map((application) => [
      application.company || '',
      application.role || '',
      statusLabel(application.status),
      formatDate(application.appliedAt || application.createdAt),
      formatDate(application.updatedAt || application.createdAt),
      hostOf(application.url) || application.source || '',
      application.url || '',
      application.notes || ''
    ]);
    return [header].concat(rows).map((row) => row.map(csvEscape).join(',')).join('\r\n');
  }

  function sortByUpdated(applications) {
    return (applications || []).slice().sort((a, b) => {
      return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
    });
  }

  return {
    STATUSES,
    STATUS_MAP,
    getStatus,
    statusLabel,
    isActive,
    isInterview,
    isClosed,
    isOffer,
    daysSince,
    needsFollowUp,
    formatDate,
    relativeDay,
    escapeHtml,
    cleanText,
    truncate,
    normalizeUrl,
    isHttpUrl,
    hostOf,
    guessCompanyFromHost,
    pickCompanyFromTitle,
    pickRoleFromTitle,
    isJobText,
    isSuccessText,
    initials,
    colorFor,
    uid,
    dateInputValue,
    dateAtNoonIso,
    csvEscape,
    toCsv,
    sortByUpdated
  };
});
