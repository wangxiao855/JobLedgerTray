/* global JobLedgerCore */
importScripts('lib/core.js');

const C = self.JobLedgerCore;
const STORAGE_KEY = 'jobledger';
const STATE_VERSION = 1;
const EMAIL_ALARM = 'jobledger-email-sync';
const DEFAULT_EMAIL_SYNC = {
  enabled: false,
  url: 'http://127.0.0.1:8787',
  token: '',
  lastSyncAt: '',
  lastError: '',
  lastResult: null
};
const DEFAULT_SETTINGS = {
  followUpDays: 7,
  emailSync: { ...DEFAULT_EMAIL_SYNC }
};
const MAX_IMPORT = 2000;
const EMAIL_STATUS_RANK = {
  applied: 0,
  screening: 1,
  assessment: 2,
  written: 3,
  interview1: 4,
  interview2: 5,
  interview3: 6,
  hr: 7,
  offer: 8,
  rejected: 9,
  ghosted: 9
};

let emailSyncInFlight = null;

function emptyState() {
  return {
    version: STATE_VERSION,
    applications: [],
    emailEvents: [],
    settings: {
      followUpDays: DEFAULT_SETTINGS.followUpDays,
      emailSync: { ...DEFAULT_EMAIL_SYNC }
    }
  };
}

async function loadState() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const raw = data[STORAGE_KEY];
  if (!raw || typeof raw !== 'object') return emptyState();
  const storedSettings = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
  const settings = { ...DEFAULT_SETTINGS, ...storedSettings };
  settings.emailSync = {
    ...DEFAULT_EMAIL_SYNC,
    ...(storedSettings.emailSync && typeof storedSettings.emailSync === 'object' ? storedSettings.emailSync : {})
  };
  return {
    version: STATE_VERSION,
    applications: Array.isArray(raw.applications) ? raw.applications : [],
    emailEvents: Array.isArray(raw.emailEvents) ? raw.emailEvents : [],
    settings
  };
}

async function saveState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

async function ensureState() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  if (!data[STORAGE_KEY]) {
    await saveState(emptyState());
  }
}

function clean(value, max) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max || 500);
}

function cleanMultiline(value, max) {
  return String(value == null ? '' : value)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max || 3000);
}

function validIso(value, fallback) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function validStatus(value) {
  return C.STATUS_MAP[value] ? value : 'applied';
}

function sanitizeEvent(event, fallbackAt) {
  if (!event || typeof event !== 'object') return null;
  return {
    status: validStatus(event.status),
    at: validIso(event.at, fallbackAt),
    note: clean(event.note, 200)
  };
}

function sanitizeApplication(input, options) {
  const source = input && typeof input === 'object' ? input : {};
  const now = new Date().toISOString();
  const createdAt = validIso(source.createdAt, now);
  const updatedAt = validIso(source.updatedAt, createdAt);
  const appliedAt = validIso(source.appliedAt, createdAt);
  const status = validStatus(source.status);
  const keepId = options && options.keepId && typeof source.id === 'string' && source.id.length <= 80;

  const events = Array.isArray(source.events)
    ? source.events.map((event) => sanitizeEvent(event, createdAt)).filter(Boolean)
    : [];

  return {
    id: keepId ? source.id : C.uid(),
    company: clean(source.company, 80) || '待确认',
    role: clean(source.role, 120) || '待确认',
    status,
    url: C.normalizeUrl(source.url || ''),
    source: clean(source.source || C.hostOf(source.url), 120),
    pageTitle: clean(source.pageTitle, 200),
    location: clean(source.location, 80),
    salary: clean(source.salary, 80),
    notes: cleanMultiline(source.notes, 1000),
    jdText: cleanMultiline(source.jdText, 3000),
    capture: clean(source.capture || 'manual', 20),
    createdAt,
    updatedAt,
    appliedAt,
    events: events.length
      ? events
      : [{ status, at: createdAt, note: '创建记录' }]
  };
}

function addEvent(application, status, note) {
  if (!Array.isArray(application.events)) application.events = [];
  application.events.push({
    status: validStatus(status),
    at: new Date().toISOString(),
    note: clean(note, 200)
  });
}

function dayKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.getFullYear() + '-' + (date.getMonth() + 1) + '-' + date.getDate();
}

function countToday(applications) {
  const today = dayKey(new Date().toISOString());
  return applications.filter((application) => dayKey(application.createdAt) === today).length;
}

function findDuplicate(applications, candidate) {
  if (candidate.url) {
    const byUrl = applications.find((application) => {
      return application.url && C.normalizeUrl(application.url) === candidate.url;
    });
    if (byUrl) return byUrl;
  }

  if (candidate.company === '待确认' && candidate.role === '待确认') return null;

  const now = Date.now();
  return applications.find((application) => {
    if (application.company !== candidate.company || application.role !== candidate.role) {
      return false;
    }
    const last = new Date(application.updatedAt || application.createdAt).getTime();
    return Number.isFinite(last) && Math.abs(now - last) < 12 * 3600 * 1000;
  }) || null;
}

function mergeDuplicate(existing, candidate) {
  const now = new Date().toISOString();
  if (candidate.company !== '待确认') existing.company = candidate.company;
  if (candidate.role !== '待确认') existing.role = candidate.role;
  if (candidate.location) existing.location = candidate.location;
  if (candidate.salary) existing.salary = candidate.salary;
  if (candidate.pageTitle) existing.pageTitle = candidate.pageTitle;
  if (candidate.jdText && candidate.jdText.length > (existing.jdText || '').length) {
    existing.jdText = candidate.jdText;
  }
  if (candidate.notes) {
    if (!existing.notes) existing.notes = candidate.notes;
    else if (!existing.notes.includes(candidate.notes)) existing.notes = existing.notes + '\n' + candidate.notes;
  }
  if (candidate.status !== 'applied' && candidate.status !== existing.status) {
    existing.status = candidate.status;
    addEvent(existing, candidate.status, '从页面重新记录时更新');
  }
  existing.updatedAt = now;
  existing.capture = candidate.capture || existing.capture;
  return existing;
}

async function saveApplication(payload) {
  const state = await loadState();
  const candidate = sanitizeApplication(payload, { keepId: false });

  if (candidate.company !== '待确认' && candidate.role !== '待确认') {
    const samePosition = state.applications.find((application) => {
      return String(application.company || '').trim().toLowerCase() === candidate.company.toLowerCase() &&
        String(application.role || '').trim().toLowerCase() === candidate.role.toLowerCase();
    });
    if (samePosition) {
      return {
        ok: false,
        code: 'DUPLICATE',
        error: '该岗位已存在：' + samePosition.company + ' · ' + samePosition.role,
        application: samePosition,
        state
      };
    }
  }

  const duplicate = findDuplicate(state.applications, candidate);
  if (duplicate) {
    return {
      ok: true,
      duplicate: true,
      application: duplicate,
      todayCount: countToday(state.applications),
      state
    };
  }

  state.applications.unshift(candidate);
  await saveState(state);
  updateBadge();
  return {
    ok: true,
    duplicate: false,
    application: candidate,
    todayCount: countToday(state.applications),
    state
  };
}

async function updateApplication(id, patch) {
  const state = await loadState();
  const application = state.applications.find((item) => item.id === id);
  if (!application) throw new Error('记录不存在');

  const now = new Date().toISOString();
  const fields = ['company', 'role', 'url', 'notes', 'location', 'salary'];
  fields.forEach((field) => {
    if (patch && Object.prototype.hasOwnProperty.call(patch, field)) {
      if (field === 'url') application.url = C.normalizeUrl(patch.url || '');
      else if (field === 'notes') application.notes = cleanMultiline(patch.notes, 1000);
      else application[field] = clean(patch[field], field === 'role' ? 120 : 80) || (field === 'company' || field === 'role' ? '待确认' : '');
    }
  });

  if (patch && patch.appliedAt) {
    application.appliedAt = validIso(patch.appliedAt, application.appliedAt);
  }

  if (patch && patch.status) {
    const nextStatus = validStatus(patch.status);
    if (nextStatus !== application.status) {
      application.status = nextStatus;
      addEvent(application, nextStatus, patch.statusNote || '手动更新');
    }
  }

  application.updatedAt = now;
  await saveState(state);
  updateBadge();
  return { ok: true, application, state };
}

async function deleteApplication(id) {
  const state = await loadState();
  state.applications = state.applications.filter((item) => item.id !== id);
  await saveState(state);
  updateBadge();
  return { ok: true, state };
}

function normalizeServiceUrl(value) {
  let text = String(value || '').trim();
  if (!text) return '';
  if (!/^https?:\/\//i.test(text)) text = 'http://' + text;
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad protocol');
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/$/, '');
  } catch (error) {
    throw new Error('邮件服务地址不正确');
  }
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 15000);
  try {
    const response = await fetch(url, { ...(options || {}), signal: controller.signal });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch (error) {
      data = {};
    }
    if (!response.ok) {
      throw new Error((data && data.error) || ('邮件服务返回 HTTP ' + response.status));
    }
    return data;
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('邮件服务连接超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function serviceUrlVariants(base) {
  const variants = [];
  try {
    const url = new URL(base);
    variants.push(url.toString().replace(/\/$/, ''));
    if (url.hostname === '127.0.0.1') {
      url.hostname = 'localhost';
      variants.push(url.toString().replace(/\/$/, ''));
    } else if (url.hostname === 'localhost') {
      url.hostname = '127.0.0.1';
      variants.push(url.toString().replace(/\/$/, ''));
    }
  } catch (error) {
    if (base) variants.push(String(base).replace(/\/$/, ''));
  }
  return Array.from(new Set(variants.filter(Boolean)));
}

async function fetchService(config, path, options, timeoutMs) {
  const bases = serviceUrlVariants(config.url);
  let lastError = null;
  for (const base of bases) {
    try {
      return await fetchJson(base + path, options, timeoutMs);
    } catch (error) {
      lastError = error;
    }
  }
  const message = lastError && lastError.message ? lastError.message : '连不上本地托盘服务';
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    throw new Error('连不上本地托盘服务，请确认 JobLedgerTray 正在运行');
  }
  throw lastError || new Error('连不上本地托盘服务');
}

function normalizeCompanyKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/(有限责任公司|股份有限公司|有限公司|集团|公司)$/g, '');
}

function emailEventTime(event) {
  const date = new Date(event && (event.occurred_at || event.received_at));
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function shouldApplyEmailStatus(current, next, eventTime, application) {
  if (!next || next === current) return false;
  const eventMs = new Date(eventTime).getTime();
  const updatedMs = new Date(application.updatedAt || application.createdAt || 0).getTime();
  if (Number.isFinite(updatedMs) && eventMs < updatedMs) return false;
  if (next === 'rejected' || next === 'offer') return true;
  const currentRank = EMAIL_STATUS_RANK[current] ?? 0;
  const nextRank = EMAIL_STATUS_RANK[next] ?? 0;
  return nextRank > currentRank;
}

function findApplicationForEmail(applications, event) {
  const eventUrl = event.url ? C.normalizeUrl(event.url) : '';
  if (eventUrl) {
    const byUrl = applications.find((application) => {
      return application.url && C.normalizeUrl(application.url) === eventUrl;
    });
    if (byUrl) return byUrl;
  }

  const companyKey = normalizeCompanyKey(event.company);
  if (!companyKey) return null;
  const candidates = applications.filter((application) => {
    return normalizeCompanyKey(application.company) === companyKey;
  });
  if (!candidates.length) return null;

  const roleKey = String(event.role || '').toLowerCase().replace(/\s+/g, '');
  if (roleKey) {
    const exact = candidates.find((application) => {
      return String(application.role || '').toLowerCase().replace(/\s+/g, '') === roleKey;
    });
    if (exact) return exact;
    const contains = candidates.find((application) => {
      const applicationRole = String(application.role || '').toLowerCase().replace(/\s+/g, '');
      return applicationRole && (applicationRole.includes(roleKey) || roleKey.includes(applicationRole));
    });
    if (contains) return contains;
    return candidates.find((application) => !application.role || application.role === '待确认') || null;
  }

  return candidates.slice().sort((a, b) => {
    return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
  })[0];
}

function emailCategoryFor(status) {
  if (status === 'written') return 'written';
  if (status === 'assessment') return 'assessment';
  if (status === 'offer') return 'offer';
  if (status === 'rejected') return 'rejection';
  if (['interview1', 'interview2', 'interview3', 'hr'].includes(status)) return 'interview';
  if (status === 'screening') return 'screening';
  return 'application';
}

function emailRecord(event, eventTime) {
  return {
    id: String(event.id),
    company: clean(event.company, 80),
    role: clean(event.role, 120),
    emailType: event.email_type === 'other' ? 'other' : 'application',
    groupTitle: clean(event.group_title, 40),
    messageId: clean(event.message_id, 300),
    webmailUrl: clean(event.webmail_url, 500),
    subject: clean(event.subject, 200),
    category: clean(event.category || emailCategoryFor(event.status), 30),
    status: event.status,
    applicationId: '',
    unread: true,
    occurredAt: eventTime,
    from: clean(event.from_email, 160),
    url: event.url ? C.normalizeUrl(event.url) : '',
    snippet: cleanMultiline(event.snippet, 300),
    classifiedBy: clean(event.classified_by || 'rules', 20),
    confidence: Number(event.confidence) || 0
  };
}

function appendEmail(application, record) {
  const existing = Array.isArray(application.emails) ? application.emails : [];
  application.emails = existing
    .filter((email) => email && email.id !== record.id)
    .concat(record)
    .sort((a, b) => new Date(b.occurredAt || 0) - new Date(a.occurredAt || 0))
    .slice(0, 50);
}

function applyEmailEvents(state, events) {
  let imported = 0;
  let updated = 0;
  let skipped = 0;

  const sorted = (events || []).slice().sort((a, b) => {
    return new Date(emailEventTime(a)) - new Date(emailEventTime(b));
  });
  const globalMap = new Map((state.emailEvents || []).filter((event) => event && event.id).map((event) => [event.id, event]));

  sorted.forEach((event) => {
    if (!event || !event.id) {
      skipped += 1;
      return;
    }
    const eventTime = emailEventTime(event);
    const status = C.STATUS_MAP[event.status] ? event.status : 'unknown';
    const normalizedEvent = Object.assign({}, event, { status });
    const record = emailRecord(normalizedEvent, eventTime);
    const previous = globalMap.get(record.id);
    if (previous) {
      record.unread = previous.unread || previous.status !== record.status || previous.subject !== record.subject || previous.emailType !== record.emailType;
    }
    if (!previous) imported += 1;
    globalMap.set(record.id, record);

    if (status === 'unknown') {
      skipped += 1;
      return;
    }

    const existing = findApplicationForEmail(state.applications, normalizedEvent);
    if (!existing) {
      if (!event.company || event.company === '待确认') {
        skipped += 1;
        return;
      }
      // 首次使用时，把没有对应岗位的招聘邮件按「公司 + 岗位」导入一次；
      // 同一公司同一岗位的后续邮件只会更新这条记录，不会重复建岗位。
      const role = clean(event.role, 120) || '待确认';
      const source = C.hostOf(event.url) || (event.from_email && event.from_email.includes('@')
        ? event.from_email.split('@')[1]
        : '');
      const application = sanitizeApplication({
        company: event.company,
        role,
        status,
        url: event.url || '',
        source,
        pageTitle: event.subject || '',
        notes: '邮件自动导入：' + clean(event.subject, 200),
        capture: 'email_import',
        createdAt: eventTime,
        updatedAt: eventTime,
        appliedAt: eventTime,
        events: [{
          status,
          at: eventTime,
          note: '邮件自动导入：' + clean(event.subject, 200)
        }]
      }, { keepId: false });
      record.applicationId = application.id;
      globalMap.set(record.id, record);
      application.emailEventIds = [String(event.id)];
      application.emailSubject = record.subject;
      application.emailFrom = record.from;
      application.emailCategory = record.category;
      application.emails = [record];
      state.applications.unshift(application);
      return;
    }

    record.applicationId = existing.id;
    globalMap.set(record.id, record);
    if (Array.isArray(existing.emailEventIds) && existing.emailEventIds.includes(String(event.id))) {
      const alreadyShown = (existing.emails || []).some((email) => email && email.id === record.id);
      if (!alreadyShown) {
        appendEmail(existing, record);
        existing.emailSubject = record.subject || existing.emailSubject || '';
        existing.emailCategory = record.category || existing.emailCategory || '';
        updated += 1;
      } else {
        skipped += 1;
      }
      if (!existing.appliedAt || new Date(eventTime).getTime() < new Date(existing.appliedAt || 0).getTime()) {
        existing.appliedAt = eventTime;
      }
      return;
    }

    appendEmail(existing, record);
    let changed = false;
    const appliedMs = new Date(existing.appliedAt || existing.createdAt || 0).getTime();
    if (!existing.appliedAt || new Date(eventTime).getTime() < appliedMs) {
      existing.appliedAt = eventTime;
      changed = true;
    }
    if (shouldApplyEmailStatus(existing.status, status, eventTime, existing)) {
      existing.status = status;
      if (!Array.isArray(existing.events)) existing.events = [];
      existing.events.push({
        status,
        at: eventTime,
        note: '邮件自动同步：' + clean(event.subject, 120)
      });
      changed = true;
    }
    if (!existing.url && event.url) {
      existing.url = C.normalizeUrl(event.url);
      changed = true;
    }
    if (event.role && (!existing.role || existing.role === '待确认')) {
      existing.role = clean(event.role, 120);
      changed = true;
    }
    if (event.company && (!existing.company || existing.company === '待确认')) {
      existing.company = clean(event.company, 80);
      changed = true;
    }
    if (new Date(eventTime).getTime() > new Date(existing.updatedAt || 0).getTime()) {
      existing.updatedAt = eventTime;
    }
    existing.emailEventIds = Array.from(new Set([...(existing.emailEventIds || []), String(event.id)])).slice(-50);
    existing.emailSubject = record.subject || existing.emailSubject || '';
    existing.emailFrom = record.from || existing.emailFrom || '';
    existing.emailCategory = record.category || existing.emailCategory || '';
    if (changed) updated += 1;
    else skipped += 1;
  });

  state.emailEvents = Array.from(globalMap.values())
    .sort((a, b) => new Date(b.occurredAt || 0) - new Date(a.occurredAt || 0))
    .slice(0, 1000);
  return { imported, updated, skipped };
}

async function syncEmailInternal(force) {
  const state = await loadState();
  const config = state.settings.emailSync;
  if (!config.enabled && !force) {
    return { ok: true, skipped: true, state };
  }

  try {
    const base = normalizeServiceUrl(config.url);
    if (!base) throw new Error('还没有填写邮件服务地址');
    const headers = {};
    if (config.token) headers['X-JobLedger-Token'] = config.token;
    const syncResult = await fetchService(config, '/sync', { method: 'POST', headers }, 180000);
    const data = await fetchService(config, '/events?limit=300', { headers }, 20000);
    const events = Array.isArray(data.events) ? data.events : [];
    const result = applyEmailEvents(state, events);
    state.settings.emailSync.lastSyncAt = new Date().toISOString();
    state.settings.emailSync.lastError = '';
    state.settings.emailSync.lastResult = {
      ...result,
      total: events.length,
      scanned: syncResult.scanned || 0,
      inserted: syncResult.inserted || 0
    };
    await saveState(state);
    updateBadge();
    return { ok: true, ...result, total: events.length, state };
  } catch (error) {
    const message = error && error.message ? error.message : '邮件同步失败';
    state.settings.emailSync.lastError = message;
    state.settings.emailSync.lastResult = null;
    await saveState(state);
    return { ok: false, error: message, state };
  }
}

function syncEmail(force) {
  if (emailSyncInFlight) return emailSyncInFlight;
  emailSyncInFlight = syncEmailInternal(Boolean(force)).finally(() => {
    emailSyncInFlight = null;
  });
  return emailSyncInFlight;
}

async function resetEmailSync() {
  const state = await loadState();
  const config = state.settings.emailSync;
  const base = normalizeServiceUrl(config.url);
  if (!base) throw new Error('还没有填写本地服务地址');
  const headers = {};
  if (config.token) headers['X-JobLedger-Token'] = config.token;
  await fetchService(config, '/events/clear', { method: 'POST', headers }, 15000);
  const next = await loadState();
  next.emailEvents = [];
  next.applications = next.applications.filter((application) => {
    return application.capture !== 'email' && application.capture !== 'email_import';
  });
  next.applications.forEach((application) => {
    delete application.emailEventIds;
    delete application.emails;
    delete application.emailSubject;
    delete application.emailFrom;
    delete application.emailCategory;
  });
  await saveState(next);
  return syncEmail(true);
}

async function testEmailService() {
  const state = await loadState();
  const config = state.settings.emailSync;
  const base = normalizeServiceUrl(config.url);
  if (!base) throw new Error('还没有填写邮件服务地址');
  const headers = {};
  if (config.token) headers['X-JobLedger-Token'] = config.token;
  const health = await fetchService(config, '/health', { headers }, 8000);
  let status = null;
  try {
    status = await fetchService(config, '/status', { headers }, 8000);
  } catch (error) {
    status = { ok: false, error: error.message };
  }
  return { ok: true, health, status };
}

async function getImapConfig() {
  const state = await loadState();
  const config = state.settings.emailSync;
  const base = normalizeServiceUrl(config.url);
  if (!base) throw new Error('还没有填写本地服务地址');
  const headers = {};
  if (config.token) headers['X-JobLedger-Token'] = config.token;
  return await fetchService(config, '/config', { headers }, 8000);
}

async function setImapConfig(payload) {
  const state = await loadState();
  const config = state.settings.emailSync;
  const base = normalizeServiceUrl(config.url);
  if (!base) throw new Error('还没有填写本地服务地址');
  const headers = { 'Content-Type': 'application/json' };
  if (config.token) headers['X-JobLedger-Token'] = config.token;
  return await fetchService(config, '/config', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload || {})
  }, 30000);
}

async function updateEmailSettings(patch) {
  const state = await loadState();
  const next = { ...state.settings.emailSync };
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'enabled')) {
    next.enabled = Boolean(patch.enabled);
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'url')) {
    next.url = normalizeServiceUrl(patch.url) || DEFAULT_EMAIL_SYNC.url;
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'token')) {
    next.token = String(patch.token || '').trim();
  }
  next.lastError = '';
  state.settings.emailSync = next;
  await saveState(state);
  if (next.enabled) {
    chrome.alarms.create(EMAIL_ALARM, { periodInMinutes: 5 });
  } else {
    chrome.alarms.clear(EMAIL_ALARM);
  }
  return { ok: true, state };
}

async function markCompanyRead(company) {
  const state = await loadState();
  const key = String(company || '').trim().toLowerCase();
  if (!key) return { ok: true, state };
  state.emailEvents = (state.emailEvents || []).map((email) => {
    return String(email.company || '').trim().toLowerCase() === key ? { ...email, unread: false } : email;
  });
  state.applications.forEach((application) => {
    if (String(application.company || '').trim().toLowerCase() === key) {
      application.emailUnread = false;
      (application.emails || []).forEach((email) => { email.unread = false; });
    }
  });
  await saveState(state);
  return { ok: true, state };
}

async function cleanEmailApplications() {
  const state = await loadState();
  const before = state.applications.length;
  state.applications = state.applications.filter((application) => application.capture !== 'email');
  await saveState(state);
  updateBadge();
  return { ok: true, removed: before - state.applications.length, state };
}

async function importApplications(list) {
  if (!Array.isArray(list)) throw new Error('导入文件格式不正确');
  const state = await loadState();
  let imported = 0;
  let skipped = 0;

  list.slice(0, MAX_IMPORT).forEach((item) => {
    const candidate = sanitizeApplication(item, { keepId: true });
    const idExists = state.applications.some((application) => application.id === candidate.id);
    const urlExists = candidate.url && state.applications.some((application) => {
      return application.url && C.normalizeUrl(application.url) === candidate.url;
    });
    if (idExists || urlExists) {
      skipped += 1;
      return;
    }
    state.applications.push(candidate);
    imported += 1;
  });

  await saveState(state);
  updateBadge();
  return { ok: true, imported, skipped, state };
}

async function clearAll() {
  const current = await loadState();
  const state = emptyState();
  state.settings = current.settings;
  await saveState(state);
  updateBadge();
  return { ok: true, state };
}

function openDashboard(focus) {
  const suffix = focus ? '?focus=' + encodeURIComponent(focus) : '';
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html' + suffix) });
}

function updateBadge() {
  loadState().then((state) => {
    const count = state.applications.filter((application) => C.isActive(application.status)).length;
    chrome.action.setBadgeText({ text: count > 99 ? '99+' : (count ? String(count) : '') });
    chrome.action.setBadgeBackgroundColor({ color: '#0f172a' });
  }).catch(() => {});
}

async function handleMessage(message) {
  switch (message.type) {
    case 'GET_STATE': {
      const state = await loadState();
      return { ok: true, state };
    }
    case 'SAVE_APPLICATION':
      return saveApplication(message.payload);
    case 'UPDATE_APPLICATION':
      return updateApplication(message.id, message.patch);
    case 'DELETE_APPLICATION':
      return deleteApplication(message.id);
    case 'IMPORT_STATE':
      return importApplications(message.applications);
    case 'CLEAR_ALL':
      return clearAll();
    case 'SYNC_EMAIL':
      return syncEmail(true);
    case 'SET_EMAIL_SYNC':
      return updateEmailSettings(message.patch || {});
    case 'TEST_EMAIL_SERVICE':
      return testEmailService();
    case 'GET_IMAP_CONFIG':
      return getImapConfig();
    case 'SET_IMAP_CONFIG':
      return setImapConfig(message.patch || {});
    case 'RESET_EMAIL_SYNC':
      return resetEmailSync();
    case 'CLEAN_EMAIL_APPS':
      return cleanEmailApplications();
    case 'MARK_COMPANY_READ':
      return markCompanyRead(message.company);
    case 'OPEN_DASHBOARD':
      openDashboard(message.focus);
      return { ok: true };
    default:
      return { ok: false, error: '未知操作' };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;
  handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) => sendResponse({ ok: false, error: error && error.message ? error.message : '操作失败' }));
  return true;
});

chrome.runtime.onInstalled.addListener(async (details) => {
  await ensureState();
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'jobledger-record',
      title: '记入投递簿',
      contexts: ['page']
    });
  });
  chrome.alarms.create(EMAIL_ALARM, { periodInMinutes: 5 });
  updateBadge();
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html?welcome=1') });
  }
});

chrome.runtime.onStartup.addListener(() => {
  ensureState().then(() => {
    chrome.alarms.create(EMAIL_ALARM, { periodInMinutes: 5 });
    updateBadge();
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === EMAIL_ALARM) {
    syncEmail(false).catch(() => {});
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'jobledger-record' || !tab || !tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'OPEN_RECORD_MODAL' }, () => {
    if (chrome.runtime.lastError) {
      chrome.action.setBadgeText({ tabId: tab.id, text: '!' });
      setTimeout(() => chrome.action.setBadgeText({ tabId: tab.id, text: '' }), 3000);
    }
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[STORAGE_KEY]) {
    updateBadge();
  }
});
