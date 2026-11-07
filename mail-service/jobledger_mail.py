#!/usr/bin/env python3
"""JobLedger local mail bridge.

Reads recruitment notification emails over IMAP, classifies them, and exposes
the parsed events on http://127.0.0.1:8787 for the JobLedger extension.

PDF attachments are read with the bundled pypdf package. Nothing leaves this
machine unless the optional LLM API is enabled.
"""

from __future__ import annotations

import argparse
import datetime as dt
import email
import email.policy
import hashlib
import html
import imaplib
import io
import json
import os
import re
import sqlite3
import sys
import threading
import urllib.parse
import urllib.request
from email.header import decode_header, make_header
from email.utils import parseaddr, parsedate_to_datetime
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
VENDOR_DIR = BASE_DIR / "vendor"
if VENDOR_DIR.exists():
    sys.path.insert(0, str(VENDOR_DIR))
try:
    from pypdf import PdfReader
except Exception:  # pragma: no cover - optional when running from source
    PdfReader = None

DEFAULT_CONFIG = {
    "imap_host": "",
    "imap_port": 993,
    "username": "",
    "password": "",
    "mailbox": "INBOX",
    "search_days": 365,
    "max_messages": 500,
    "http_host": "127.0.0.1",
    "http_port": 8787,
    "token": "",
    "db_path": "jobledger-mail.db",
    "llm_enabled": False,
    "llm_base_url": "",
    "llm_api_key": "",
    "llm_model": "",
    "llm_timeout": 25,
}

LLM_STATUSES = {
    "applied", "screening", "assessment", "written",
    "interview1", "interview2", "interview3", "hr",
    "offer", "rejected", "unknown",
}
LLM_CATEGORY_BY_STATUS = {
    "applied": "application",
    "screening": "screening",
    "assessment": "assessment",
    "written": "written",
    "interview1": "interview",
    "interview2": "interview",
    "interview3": "interview",
    "hr": "interview",
    "offer": "offer",
    "rejected": "rejection",
    "unknown": "other",
}

ATS_DOMAINS = {
    "mokahr.com", "moka.com", "zhiye.com", "hotjob.cn", "51job.com", "zhaopin.com",
    "zhipin.com", "liepin.com", "lagou.com", "nowcoder.com", "shixiseng.com",
    "yingjiesheng.com", "dajie.com", "wjx.cn", "jinshuju.net", "docs.qq.com",
    "feishu.cn", "larksuite.com", "workday.com", "myworkdayjobs.com",
    "greenhouse.io", "lever.co", "smartrecruiters.com", "icims.com", "taleo.net",
    "successfactors.com", "beisen.com", "italent.cn", "dayee.com", "gllue.com",
}

FREE_DOMAINS = {
    "qq.com", "163.com", "126.com", "gmail.com", "outlook.com", "hotmail.com",
    "foxmail.com", "sina.com", "sohu.com", "yahoo.com", "icloud.com", "me.com",
}

ATS_BRANDS = {
    "moka", "mokahr", "北森", "beisen", "智联", "前程无忧", "boss直聘", "猎聘",
    "拉勾", "牛客", "实习僧", "workday", "greenhouse", "lever", "smartrecruiters",
    "icims", "taleo", "successfactors", "问卷星", "金数据", "飞书", "腾讯文档",
}

COMPANY_SUFFIX = (
    "公司|集团|科技|银行|证券|保险|大学|学院|研究院|事务所|工作室|中心|医院|"
    "汽车|地产|教育|网络|信息|数据|智能|传媒|文化|电商|物流|医药|生物|能源|"
    "制造|电子|通信|软件"
)
COMPANY_RE = re.compile(
    r"([\u4e00-\u9fa5A-Za-z0-9（）()·]{2,30}(?:" + COMPANY_SUFFIX + r"))"
)
STATUS_WORDS = re.compile(
    r"(面试邀请|面试通知|笔试通知|测评通知|录用通知|感谢信|面试|笔试|测评|"
    r"offer|录取|录用|申请成功|投递成功|通知)",
    re.IGNORECASE,
)
ROLE_WORDS = re.compile(
    r"(工程师|经理|专员|主管|助理|设计师|运营|产品|销售|客服|会计|财务|人力|"
    r"行政|法务|编辑|记者|教师|医生|护士|司机|店长|顾问|分析师|研究员|开发|"
    r"算法|实习|管培生)",
    re.IGNORECASE,
)

RECRUITMENT_STRONG = re.compile(
    r"(投递成功|申请成功|简历已收到|已收到您的简历|感谢您的投递|面试邀请|面试通知|"
    r"面试安排|笔试通知|测评通知|录用通知|正式录用|offer letter|未通过|感谢信|"
    r"应聘|简历通过|初筛通过|进入下一轮|进入面试|录用|录取|聘用)",
    re.IGNORECASE,
)
RECRUITMENT_WEAK = re.compile(
    r"(招聘|岗位|职位|简历|面试|笔试|测评|申请|投递|录用|录取|offer|人才|"
    r"talent|recruit|career|job|application|interview)",
    re.IGNORECASE,
)
RECRUITMENT_NEGATIVE = re.compile(
    r"(退订|unsubscribe|职位推荐|为你推荐|广告|营销|优惠|发票|订单|账单|"
    r"验证码|密码重置)",
    re.IGNORECASE,
)
RECRUITMENT_CONTEXT = re.compile(
    r"(面试(?:时间|地点|安排|邀请|通知|官)|(?:参加|进行|安排|预约|来|线上|现场)面试|"
    r"笔试(?:时间|链接|通知|安排)|(?:参加|进行|安排)笔试|"
    r"测评(?:链接|时间|通知)|(?:参加|完成)测评)",
    re.IGNORECASE,
)
TRACKING_WORDS = re.compile(
    r"(unsubscribe|privacy|terms|weibo|linkedin|facebook|twitter|youtube|instagram|"
    r"doubleclick|click\.|links\.|email\.|mailchi|sendgrid|mandrill)",
    re.IGNORECASE,
)
URL_RE = re.compile(r"https?://[^\s<>\"'）)】\]]+", re.IGNORECASE)


class ConfigError(RuntimeError):
    pass


class _HTMLText(HTMLParser):
    SKIP = {"script", "style", "head", "title"}
    BREAK = {"p", "br", "div", "li", "tr", "h1", "h2", "h3", "h4", "table", "section"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip = 0

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag in self.SKIP:
            self.skip += 1
        elif not self.skip and tag in self.BREAK:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in self.SKIP and self.skip:
            self.skip -= 1
        elif not self.skip and tag in self.BREAK:
            self.parts.append("\n")

    def handle_startendtag(self, tag: str, attrs) -> None:
        if tag in self.BREAK and not self.skip:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self.skip:
            self.parts.append(data)


class _LinkCollector(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[str] = []

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag.lower() != "a":
            return
        for key, value in attrs:
            if key.lower() == "href" and value:
                self.links.append(value)


def html_to_text(value: str) -> str:
    parser = _HTMLText()
    try:
        parser.feed(value)
        return "".join(parser.parts)
    except Exception:
        return re.sub(r"<[^>]+>", " ", value)


def normalize_space(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def decode_mime(value: str | None) -> str:
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except Exception:
        return str(value)


def domain_of(address: str) -> str:
    if not address or "@" not in address:
        return ""
    return address.rsplit("@", 1)[1].strip().lower().strip(".")


def host_matches(host: str, domain: str) -> bool:
    return host == domain or host.endswith("." + domain)


def is_ats_domain(host: str) -> bool:
    return any(host_matches(host, domain) for domain in ATS_DOMAINS)


def is_free_domain(host: str) -> bool:
    return any(host_matches(host, domain) for domain in FREE_DOMAINS)


def guess_company_from_host(host: str) -> str:
    if not host or re.fullmatch(r"[\d.:]+", host):
        return ""
    parts = host.replace("www.", "").split(".")
    if len(parts) < 2:
        return ""
    prefixes = {
        "jobs", "job", "careers", "career", "campus", "hr", "recruit", "recruiting",
        "talent", "zhaopin", "apply", "join", "joinus", "home", "mail", "email", "www",
        "no-reply", "noreply",
    }
    index = 0
    while index < len(parts) - 2 and parts[index].lower() in prefixes:
        index += 1
    name = parts[index] if index < len(parts) - 1 else parts[0]
    if not re.search(r"[a-zA-Z]", name):
        return ""
    return re.sub(r"[-_]+", " ", name).title()


def clean_company(value: str) -> str:
    text = normalize_space(decode_mime(value))
    text = text.strip("\"'“”‘’【】[]<>()（） ")
    text = re.sub(r"^(?:来自|欢迎加入|感谢您对|感谢您应聘)\s*", "", text)
    text = re.sub(
        r"(?:招聘团队|招聘中心|校园招聘|社会招聘|人才招聘|招聘|HR|人力资源部|人力资源|人力行政部)$",
        "",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(r"\s*(?:19|20)\d{2}\s*$", "", text)
    text = text.strip(" -—|,，。;；:：")
    if not 2 <= len(text) <= 40:
        return ""
    if text.lower() in ATS_BRANDS or text in ATS_BRANDS:
        return ""
    if re.fullmatch(r"(hr|recruit(ing)?|talent|no.?reply|noreply|admin|通知|招聘)", text, re.IGNORECASE):
        return ""
    if STATUS_WORDS.fullmatch(text):
        return ""
    if re.search(r"(请于|请在|完成|你在|您在|你已|您已|投递|申请|职位|岗位|通知|邮件|今日|尽快|感谢|恭喜)", text):
        return ""
    if re.search(r"^(?:greetings|hello|hi|dear|thank|welcome|from|your application|application)\b", text, re.IGNORECASE):
        return ""
    return text


def company_from_subject(subject: str) -> str:
    bracket = re.search(r"[【\[]([^】\]]{2,40})[】\]]", subject)
    if bracket:
        value = clean_company(bracket.group(1))
        if value:
            return value

    for match in COMPANY_RE.finditer(subject):
        value = clean_company(match.group(1))
        if value:
            return value

    sentence_patterns = [
        r"(?:你在|您在|你已投递|您已投递|你投递的|您投递的)\s*([\u4e00-\u9fa5A-Za-z0-9（）()·\-]{2,30}?)\s*(?:的)?\s*(?:职位|岗位|实习|工作|申请)",
        r"(?:感谢您应聘|感谢您投递|欢迎加入|来自)\s*([\u4e00-\u9fa5A-Za-z0-9（）()·\-]{2,30}?)(?:的|，|。|$)",
        r"([\u4e00-\u9fa5A-Za-z0-9（）()·\-]{2,30}?)\s*(?:的)?\s*(?:职位|岗位)\s*(?:申请|邀请|确认|通知)",
    ]
    for pattern in sentence_patterns:
        match = re.search(pattern, subject, re.IGNORECASE)
        if match:
            value = clean_company(match.group(1))
            if value:
                return value

    prefix = re.match(r"^([\u4e00-\u9fa5A-Za-z0-9·]{2,30})\s*(?:招聘|HR|人力资源|校园招聘|人才招聘)", subject, re.IGNORECASE)
    if prefix:
        value = clean_company(prefix.group(1))
        if value:
            return value

    parts = re.split(r"\s*[-|｜–—_]\s*", subject)
    for part in parts:
        value = clean_company(part)
        if value and not STATUS_WORDS.search(value) and not ROLE_WORDS.search(value):
            return value
    return ""


def company_from_body(body: str) -> str:
    head = body[:6000]
    patterns = [
        r"(?:公司名称|公司|企业)\s*[:：]\s*([^\n，。；;]{2,40})",
        r"(?:感谢您(?:对|应聘|投递)|欢迎加入|来自)\s*([^\s，。；;]{2,30}(?:" + COMPANY_SUFFIX + r"))",
        r"([\u4e00-\u9fa5A-Za-z0-9（）()·]{2,30}(?:" + COMPANY_SUFFIX + r"))\s*(?:诚邀|邀请|欢迎|期待)",
    ]
    for pattern in patterns:
        match = re.search(pattern, head)
        if match:
            value = clean_company(match.group(1))
            if value:
                return value
    for line in head.splitlines():
        line = line.strip()
        if 2 <= len(line) <= 35 and re.search(r"(公司|集团|科技|银行|证券|医院|大学|研究院|事务所)$", line):
            value = clean_company(line)
            if value:
                return value
    return ""


def extract_company(subject: str, body: str, from_name: str, from_email: str) -> tuple[str, str]:
    subject_value = company_from_subject(subject)
    if subject_value:
        return subject_value, "subject"

    cleaned_name = clean_company(from_name)
    if cleaned_name and re.search(r"(招聘|HR|人力资源|公司|集团|科技|银行|证券|医院|大学|研究院|事务所)", from_name, re.IGNORECASE):
        return cleaned_name, "from"

    body_value = company_from_body(body)
    if body_value:
        return body_value, "body"

    if cleaned_name:
        return cleaned_name, "from"

    host = domain_of(from_email)
    if host and not is_ats_domain(host) and not is_free_domain(host):
        value = clean_company(guess_company_from_host(host))
        if value:
            return value, "domain"

    return "待确认", "unknown"


def clean_role(value: str, company: str) -> str:
    text = normalize_space(value)
    text = text.strip("\"'“”‘’【】[]<>()（） ")
    text = re.sub(r"^(?:感谢您|感谢|诚邀您|邀请您|恭喜您)\s*", "", text)
    text = re.sub(r"^(?:我们|您|你|我)(?:的)?\s*", "", text)
    text = re.sub(r"^(?:应聘|申请|投递)\s*(?:岗位|职位)?\s*[:：]?\s*", "", text)
    text = re.sub(r"^(?:面试|笔试|测评|录用|入职)\s*(?:岗位|职位)?\s*[:：]\s*", "", text)
    text = re.sub(r"^(?:岗位|职位)\s*[:：]\s*", "", text)
    text = re.sub(r"\s*(?:面试邀请|面试通知|笔试通知|测评通知|录用通知|感谢信|面试|笔试|测评|offer)\s*$", "", text, flags=re.IGNORECASE)
    text = re.sub(r"[（(](?:上海|北京|深圳|广州|杭州|成都|南京|武汉|苏州|西安|重庆|天津|远程)[）)]?\s*$", "", text)
    text = text.strip(" -—|,，。;；:：")
    if not 2 <= len(text) <= 60:
        return ""
    if company and text == company:
        return ""
    if re.fullmatch(r"(?:您|你)?的?(?:投递|申请|应聘)(?:[!！。])?", text):
        return ""
    if re.search(r"(?:投递|申请|应聘)[!！。]?$", text) and len(text) <= 10:
        return ""
    if re.fullmatch(r"(岗位|职位|招聘|应聘|申请|面试|笔试|测评|录用|通知)", text):
        return ""
    if re.fullmatch(r"(?:\d{4}\s*)?(?:校园|社会|春季|秋季)?招聘(?:会|活动)?", text):
        return ""
    if re.search(r"20\d{2}.{0,8}(?:校园|社会|春季|秋季)?招聘", text):
        return ""
    if re.search(r"(简历|投递|面试|笔试|测评|录用|入职|申请|招聘).*(通知|结果|流程|确认|成功|完成)", text):
        return ""
    if re.match(r"^(简历|投递|面试|笔试|测评|录用|入职|申请)", text):
        return ""
    return text


def role_from_subject(subject: str, company: str) -> str:
    text = re.sub(r"[【\[][^】\]]{1,40}[】\]]", " ", subject)
    if company:
        text = text.replace(company, " ")
    for pattern in [
        r"(?:应聘|申请|投递|面试|笔试|测评|录用|入职)\s*(?:岗位|职位)?\s*[:：]\s*([^，。；;\n]{2,40})",
        r"(?:岗位|职位)\s*[:：]\s*([^，。；;\n]{2,40})",
        r"(?:position|role)\s*[:：]\s*([^，。；;\n]{2,60})",
    ]:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            value = clean_role(match.group(1), company)
            if value:
                return value

    parts = re.split(r"\s*[-|｜–—_]\s*", text)
    for part in parts:
        value = clean_role(part, company)
        if value and not STATUS_WORDS.search(value):
            return value
    return ""


def extract_role(subject: str, body: str, company: str) -> str:
    # 岗位只从正文提取。标题里的“感谢您的投递”“2027 校园招聘”等
    # 很容易被误当成岗位，因此不再用 title 作为岗位来源。
    head = body[:5000]
    for pattern in [
        r"收到您对(?:我们)?\s*(?:[A-Za-z0-9 .&/]{1,20}\s+)?([\u4e00-\u9fa5][^，。；;\n]{1,50}?)\s*的\s*(?:申请|投递)",
        r"(?:感谢|收到).{0,20}?(?:对|投递|申请).{0,6}?([\u4e00-\u9fa5][^，。；;\n]{2,50}?)\s*的\s*(?:申请|投递)",
        r"(?:申请|应聘)\s*([^，。；;\n]{2,50}?)\s*(?:岗位|职位)",
        r"(?:应聘|申请|投递|面试|笔试|测评|录用|入职)\s*(?:岗位|职位)?\s*[:：]\s*([^\n，。；;]{2,40})",
        r"(?:岗位|职位)\s*[:：]\s*([^\n，。；;]{2,40})",
        r"(?:position|role)\s*[:：]\s*([^\n，。；;]{2,60})",
    ]:
        match = re.search(pattern, head, re.IGNORECASE)
        if match:
            value = clean_role(match.group(1), company)
            if value:
                return value
    return ""


def strip_quoted(text: str) -> str:
    parts = re.split(
        r"\n\s*(?:-{2,}\s*原始邮件\s*-{2,}|发件人\s*[:：]|From\s*:)\s*",
        text,
        maxsplit=1,
        flags=re.IGNORECASE,
    )
    return parts[0] if parts else text


def decode_part(part) -> str:
    payload = part.get_payload(decode=True)
    if payload is None:
        return ""
    charset = part.get_content_charset() or "utf-8"
    try:
        return payload.decode(charset, errors="replace")
    except LookupError:
        return payload.decode("utf-8", errors="replace")


def extract_pdf_text(payload: bytes) -> str:
    if not payload or PdfReader is None:
        return ""
    try:
        reader = PdfReader(io.BytesIO(payload))
        if getattr(reader, "is_encrypted", False):
            try:
                reader.decrypt("")
            except Exception:
                return ""
        pages = []
        for page in reader.pages[:12]:
            try:
                text = page.extract_text() or ""
            except Exception:
                continue
            if text.strip():
                pages.append(text)
        text = "\n".join(pages)
        text = re.sub(r"[ \t]+", " ", text)
        text = re.sub(r"\n{3,}", "\n\n", text).strip()
        return text[:20000]
    except Exception:
        return ""


def pdf_text_from_message(message) -> str:
    chunks = []
    for part in message.walk():
        if part.is_multipart():
            continue
        filename = part.get_filename() or ""
        content_type = part.get_content_type()
        if content_type != "application/pdf" and not filename.lower().endswith(".pdf"):
            continue
        try:
            payload = part.get_payload(decode=True)
        except Exception:
            payload = None
        text = extract_pdf_text(payload or b"")
        if text:
            chunks.append(text)
    return "\n\n".join(chunks)[:20000]


def message_content(message) -> tuple[str, str, str]:
    plain: list[str] = []
    html_parts: list[str] = []
    for part in message.walk():
        if part.is_multipart():
            continue
        disposition = (part.get("Content-Disposition") or "").lower()
        if "attachment" in disposition:
            continue
        content_type = part.get_content_type()
        if content_type == "text/plain":
            plain.append(decode_part(part))
        elif content_type == "text/html":
            html_parts.append(decode_part(part))

    body = "\n".join(item for item in plain if item).strip()
    if len(body) < 40 and html_parts:
        body = html_to_text("\n".join(html_parts))
    body = strip_quoted(body).strip()
    body = re.sub(r"[ \t]+", " ", body)
    body = re.sub(r"\n{3,}", "\n\n", body)
    return body[:20000], "\n".join(html_parts)[:60000], pdf_text_from_message(message)


def is_recruitment_email(subject: str, body: str, from_email: str) -> bool:
    """Avoid turning every personal email into an application event."""
    text = (subject + "\n" + body).lower()
    if RECRUITMENT_NEGATIVE.search(subject.lower()) and not RECRUITMENT_STRONG.search(text):
        return False
    if re.fullmatch(r"(面试|笔试|测评|录用|offer)(通知|邀请|安排)?", subject.strip(), re.IGNORECASE):
        return True
    if RECRUITMENT_STRONG.search(text) or RECRUITMENT_CONTEXT.search(text):
        return True
    if is_ats_domain(domain_of(from_email)) and RECRUITMENT_WEAK.search(text):
        return True
    weak_hits = set(RECRUITMENT_WEAK.findall(text))
    return len(weak_hits) >= 2


def classify(subject: str, body: str) -> tuple[str, float, list[str]]:
    subject_lower = subject.lower()
    body_lower = body.lower()
    rules = [
        ("rejected", ["未通过", "遗憾", "不合适", "不匹配", "感谢信", "未能进入", "暂不匹配", "不予录用", "不录用", "未录用", "没有通过"]),
        ("offer", ["offer", "录用", "录取", "聘用", "入职通知", "offer letter", "正式录用"]),
        ("interview", ["面试", "面谈", "复试", "终面", "初面", "二面", "三面", "interview"]),
        ("written", ["笔试", "在线考试", "考试链接", "written test"]),
        ("assessment", ["测评", "性格测试", "能力测试", "在线测评", "assessment"]),
        ("screening", ["简历通过", "初筛通过", "简历筛选通过", "进入下一轮", "进入面试", "简历评估通过"]),
        ("applied", ["投递成功", "申请成功", "简历已收到", "已收到您的简历", "报名成功", "感谢您的投递"]),
    ]

    scores: dict[str, int] = {}
    matches: dict[str, list[str]] = {}
    for status, keywords in rules:
        score = 0
        found: list[str] = []
        for keyword in keywords:
            if keyword in subject_lower:
                score += 3
                found.append(keyword)
            elif keyword in body_lower:
                score += 1
                found.append(keyword)
        scores[status] = score
        matches[status] = found

    # A rejection can mention an interview or even the word "录用" in the subject;
    # explicit negative phrases must win over the offer rule.
    rejection_strong = any(
        keyword in subject_lower or keyword in body_lower
        for keyword in ["未通过", "不予录用", "不录用", "未录用", "没有通过", "未能进入", "暂不匹配"]
    )
    if scores["rejected"] > 0 and (scores["offer"] == 0 or rejection_strong):
        status = "rejected"
    elif scores["offer"] > 0:
        status = "offer"
    else:
        status = max(scores, key=lambda item: (scores[item], -list(scores).index(item)))
        if scores[status] == 0:
            status = "applied"

    subject_hit = any(keyword in subject_lower for keyword in matches[status])
    body_hit = any(keyword in body_lower for keyword in matches[status])
    confidence = 0.55
    if subject_hit:
        confidence += 0.2
    if body_hit:
        confidence += 0.1
    if len(matches[status]) >= 2:
        confidence += 0.05
    return status, min(0.99, round(confidence, 2)), matches[status]


def clean_url(value: str) -> str:
    url = html.unescape(value.strip())
    url = url.rstrip(".,;:!?，。；：！？)]}】》")
    if not url.lower().startswith(("http://", "https://")):
        return ""
    return url[:2000]


def extract_links(text: str, html_body: str) -> list[str]:
    links = URL_RE.findall(text)
    collector = _LinkCollector()
    try:
        collector.feed(html_body or "")
        links.extend(collector.links)
    except Exception:
        pass
    cleaned: list[str] = []
    for link in links:
        value = clean_url(link)
        if value and value not in cleaned:
            cleaned.append(value)
    return cleaned


def score_link(url: str) -> int:
    lower = url.lower()
    score = 0
    if re.search(r"(job|career|recruit|interview|apply|zhaopin|campus|talent|position|offer)", lower):
        score += 5
    if TRACKING_WORDS.search(lower):
        score -= 5
    if re.search(r"(unsubscribe|privacy|terms|login|signin|help|faq)", lower):
        score -= 3
    if any(host in lower for host in ("mokahr.com", "zhiye.com", "beisen.com", "hotjob.cn", "51job.com", "zhipin.com", "liepin.com")):
        score += 1
    return score


def best_link(text: str, html_body: str) -> str:
    links = extract_links(text, html_body)
    if not links:
        return ""
    ranked = sorted(links, key=score_link, reverse=True)
    return ranked[0] if score_link(ranked[0]) > -3 else ""


def llm_is_enabled(config: dict | None) -> bool:
    return bool(
        config
        and config.get("llm_enabled")
        and str(config.get("llm_base_url") or "").strip()
        and str(config.get("llm_api_key") or "").strip()
        and str(config.get("llm_model") or "").strip()
    )


def llm_endpoint(base_url: str) -> str:
    base = str(base_url or "").strip().rstrip("/")
    if base.endswith("/chat/completions"):
        return base
    return base + "/chat/completions"


def llm_chat(config: dict, messages: list[dict]) -> str:
    endpoint = llm_endpoint(config["llm_base_url"])
    payload = {
        "model": config["llm_model"],
        "messages": messages,
        "temperature": 0,
        "max_tokens": 500,
    }
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + str(config["llm_api_key"]).strip(),
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=max(5, int(config.get("llm_timeout") or 25))) as response:
        data = json.loads(response.read().decode("utf-8"))
    choices = data.get("choices") or []
    if not choices:
        raise RuntimeError("大模型没有返回 choices")
    message = choices[0].get("message") or {}
    content = message.get("content") or choices[0].get("text") or ""
    if isinstance(content, list):
        content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
    return str(content)


def classify_with_llm(
    config: dict,
    subject: str,
    body: str,
    from_name: str,
    from_email: str,
) -> tuple[dict | None, str]:
    if not llm_is_enabled(config):
        return None, ""
    system = (
        "你是招聘邮件分类器。只输出一个 JSON 对象，不要 Markdown。"
        "字段：email_type(枚举)、is_recruitment(布尔)、status(枚举)、category(枚举)、"
        "company(字符串)、role(字符串)、group_title(字符串)、confidence(0到1)、reason(简短中文)。"
        "email_type 只能是 application 或 other。"
        "application 表示这封邮件属于某个具体岗位的投递流程；"
        "other 表示这是该公司发来的其他相关邮件（信息确认、材料补充、账号、宣讲等），"
        "或虽然是投递流程但邮件里没有具体岗位信息。"
        "status 只能是：applied, screening, assessment, written, interview1, interview2, "
        "interview3, hr, offer, rejected, unknown。"
        "category 只能是：application, screening, assessment, written, interview, offer, "
        "rejection, other。"
        "判断规则：投递确认/applied；简历通过/screening；测评/assessment；笔试/written；"
        "面试/interview1-3；HR面/hr；录用/offer；拒绝/rejected；不相关/unknown。"
        "is_recruitment 只在邮件与用户本人的投递/面试/笔试/测评/录用直接相关时为 true；"
        "职位推荐、招聘广告、订阅简报、猎头群发应返回 false。"
        "company 只返回公司/品牌名本身，不要带“你在”“请于”“职位申请”等句子；"
        "role 只在 email_type=application 时返回邮件正文中明确出现的岗位名称；"
        "必须只从正文的“申请…岗位”“岗位：…”“收到您对…的申请”等语句提取，"
        "禁止从邮件主题、标题、发件人、公司名或签名中猜测岗位；"
        "即使主题里出现岗位名，也不要使用；正文写“游戏开发实习生（上海）”时返回“游戏开发实习生”；"
        "邮件没有明确岗位时 role 返回空字符串，不要用“简历已收到”“2027 校园招聘”等句子或泛称充当岗位；"
        "group_title 只在 email_type=other 时返回 4 到 12 个字的内容摘要，application 时返回空字符串。"
    )
    user = (
        f"发件人：{from_name} <{from_email}>\n"
        f"主题（只用于判断公司/状态，禁止从中提取岗位）：{subject}\n"
        f"正文（岗位只能从这里提取，截断）：\n{body[:6000]}"
    )
    try:
        content = llm_chat(config, [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ])
        match = re.search(r"\{.*\}", content, re.DOTALL)
        if not match:
            raise RuntimeError("大模型返回不是 JSON")
        payload = json.loads(match.group(0))
        status = str(payload.get("status") or "unknown")
        if status not in LLM_STATUSES:
            status = "unknown"
        category = str(payload.get("category") or "")
        if category not in set(LLM_CATEGORY_BY_STATUS.values()):
            category = LLM_CATEGORY_BY_STATUS.get(status, "other")
        try:
            confidence = max(0.0, min(1.0, float(payload.get("confidence", 0.7))))
        except (TypeError, ValueError):
            confidence = 0.7
        email_type = str(payload.get("email_type") or "").strip().lower()
        if email_type not in {"application", "other"}:
            email_type = "application" if status != "unknown" else "other"
        return {
            "email_type": email_type,
            "is_recruitment": bool(payload.get("is_recruitment", True)),
            "status": status,
            "category": category,
            "company": normalize_space(str(payload.get("company") or ""))[:80],
            "role": normalize_space(str(payload.get("role") or ""))[:120],
            "group_title": normalize_space(str(payload.get("group_title") or ""))[:40],
            "confidence": confidence,
            "reason": normalize_space(str(payload.get("reason") or ""))[:200],
        }, ""
    except Exception as error:
        return None, str(error)


def llm_test(config: dict) -> dict:
    if not llm_is_enabled(config):
        return {"ok": False, "error": "大模型未启用或配置不完整"}
    result, error = classify_with_llm(
        config,
        "面试邀请",
        "您好，邀请您参加数据分析师岗位的一面，面试时间 10 月 24 日 14:00。",
        "测试 HR",
        "hr@example.com",
    )
    if not result:
        return {"ok": False, "error": error or "大模型调用失败"}
    return {"ok": True, "status": result["status"], "category": result["category"]}


def parse_date(value: str | None) -> dt.datetime:
    if value:
        try:
            parsed = parsedate_to_datetime(value)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=dt.timezone.utc)
            return parsed.astimezone(dt.timezone.utc)
        except Exception:
            pass
    return dt.datetime.now(dt.timezone.utc)


def webmail_link(config: dict, message_id: str, subject: str) -> str:
    host = str(config.get("imap_host") or "").lower()
    if "gmail" in host:
        return "https://mail.google.com/mail/u/0/#search/rfc822msgid%3A" + urllib.parse.quote(message_id, safe="")
    if any(part in host for part in ("outlook", "hotmail", "live.com")):
        return "https://outlook.live.com/mail/0/search?q=" + urllib.parse.quote(subject, safe="")
    if "163" in host:
        return "https://mail.163.com/"
    if "126" in host:
        return "https://mail.126.com/"
    if "qq" in host:
        return "https://mail.qq.com/"
    return ""


def other_group_title(subject: str) -> str:
    text = normalize_space(subject)
    text = re.sub(r"^(?:回复|转发|Re|Fwd)\s*[:：]\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"[【\[]([^】\]]{1,40})[】\]]", r"\1", text)
    text = text.strip(" -—|,，。;；:：")
    return text[:12] or "其他邮件"


def parse_email(raw: bytes, source: str = "imap", llm_config: dict | None = None) -> dict:
    message = email.message_from_bytes(raw, policy=email.policy.default)
    subject = normalize_space(decode_mime(message.get("Subject")))
    from_header = decode_mime(message.get("From"))
    from_name, from_email = parseaddr(from_header)
    from_name = normalize_space(decode_mime(from_name))
    from_email = (from_email or "").strip().lower()
    body, html_body, pdf_body = message_content(message)
    if pdf_body:
        body = (body + "\n\n[PDF附件正文]\n" + pdf_body).strip()[:30000]
    relevant = is_recruitment_email(subject, body, from_email)
    status, confidence, matched = classify(subject, body)
    company, company_source = extract_company(subject, body, from_name, from_email)
    role = extract_role(subject, body, company)
    url = best_link(body, html_body)
    occurred = parse_date(message.get("Date"))
    message_id = (message.get("Message-ID") or "").strip()
    if not message_id:
        message_id = "sha1:" + hashlib.sha1(raw).hexdigest()

    category = LLM_CATEGORY_BY_STATUS.get(status, "other")
    email_type = "application" if relevant and role else "other"
    group_title = ""
    classified_by = "rules"
    llm_reason = ""
    if relevant and llm_is_enabled(llm_config):
        llm, llm_error = classify_with_llm(llm_config, subject, body, from_name, from_email)
        if llm:
            relevant = bool(llm.get("is_recruitment", True))
            email_type = llm.get("email_type") or ("application" if role else "other")
            if email_type == "application":
                if llm.get("status") and llm["status"] != "unknown":
                    status = llm["status"]
                category = llm.get("category") or category
                if llm.get("role"):
                    candidate_role = clean_role(llm["role"], company)
                    # 只接受正文里真实出现的岗位名，防止模型又从标题抄一个。
                    if candidate_role and candidate_role in normalize_space(body):
                        role = candidate_role
                if not role:
                    email_type = "other"
            if email_type == "other":
                role = ""
                status = "unknown"
                category = "other"
                group_title = llm.get("group_title") or ""
            if llm.get("company"):
                company = clean_company(llm["company"]) or company
                company_source = "llm"
            confidence = llm.get("confidence", 0.7)
            classified_by = "llm"
            llm_reason = llm.get("reason", "")
        else:
            llm_reason = "大模型调用失败：" + (llm_error or "未知错误")

    if email_type == "other":
        role = ""
        status = "unknown"
        category = "other"
        group_title = group_title or other_group_title(subject)
    else:
        group_title = ""

    event_id = hashlib.sha1((message_id + status + company + role).encode("utf-8")).hexdigest()[:24]

    if classified_by == "rules":
        if company != "待确认":
            confidence = min(0.99, confidence + 0.05)
        if not role:
            confidence = max(0.4, confidence - 0.05)

    return {
        "id": event_id,
        "message_id": message_id,
        "company": company,
        "company_source": company_source,
        "role": role,
        "status": status,
        "category": category,
        "email_type": email_type,
        "group_title": group_title,
        "subject": subject,
        "from_name": from_name,
        "from_email": from_email,
        "occurred_at": occurred.isoformat(),
        "url": url,
        "snippet": body[:280],
        "confidence": round(confidence, 2),
        "matched_keywords": matched,
        "classified_by": classified_by,
        "llm_reason": llm_reason,
        "relevant": relevant,
        "source": source,
    }


def load_config(path: Path) -> dict:
    config = dict(DEFAULT_CONFIG)
    if path.exists():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                config.update({key: loaded[key] for key in loaded if key in DEFAULT_CONFIG})
        except Exception as error:
            raise ConfigError(f"无法读取配置文件 {path}: {error}") from error

    env_map = {
        "JOBLEDGER_IMAP_HOST": "imap_host",
        "JOBLEDGER_IMAP_PORT": "imap_port",
        "JOBLEDGER_IMAP_USER": "username",
        "JOBLEDGER_IMAP_PASSWORD": "password",
        "JOBLEDGER_MAILBOX": "mailbox",
        "JOBLEDGER_HTTP_HOST": "http_host",
        "JOBLEDGER_HTTP_PORT": "http_port",
        "JOBLEDGER_TOKEN": "token",
        "JOBLEDGER_DB": "db_path",
    }
    for env_key, config_key in env_map.items():
        if os.environ.get(env_key):
            config[config_key] = os.environ[env_key]

    for key in ("imap_port", "http_port", "search_days", "max_messages"):
        try:
            config[key] = int(config[key])
        except (TypeError, ValueError):
            config[key] = DEFAULT_CONFIG[key]
    for key in ("imap_host", "username", "password", "mailbox", "http_host", "token"):
        config[key] = str(config.get(key) or "").strip()

    db_path = Path(str(config["db_path"]))
    if not db_path.is_absolute():
        db_path = path.parent / db_path
    config["db_path"] = str(db_path)
    config["config_path"] = str(path)
    return config


def is_configured(config: dict) -> bool:
    return bool(config.get("imap_host") and config.get("username") and config.get("password"))


def open_db(path: str) -> sqlite3.Connection:
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS events (
            id TEXT PRIMARY KEY,
            message_id TEXT,
            company TEXT,
            company_source TEXT,
            role TEXT,
            status TEXT,
            subject TEXT,
            from_name TEXT,
            from_email TEXT,
            occurred_at TEXT,
            url TEXT,
            snippet TEXT,
            confidence REAL,
            matched_keywords TEXT,
            source TEXT,
            category TEXT,
            classified_by TEXT,
            llm_reason TEXT,
            email_type TEXT,
            group_title TEXT,
            webmail_url TEXT
        )
        """
    )
    existing = {
        row["name"] for row in connection.execute("PRAGMA table_info(events)").fetchall()
    }
    for column in ("category", "classified_by", "llm_reason", "email_type", "group_title", "webmail_url"):
        if column not in existing:
            connection.execute(f"ALTER TABLE events ADD COLUMN {column} TEXT")
    connection.execute(
        "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)"
    )
    connection.commit()
    return connection


def set_meta(connection: sqlite3.Connection, key: str, value: str) -> None:
    connection.execute(
        "INSERT INTO meta (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )
    connection.commit()


def get_meta(connection: sqlite3.Connection, key: str) -> str:
    row = connection.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else ""


def insert_event(connection: sqlite3.Connection, event: dict) -> bool:
    cursor = connection.execute(
        """
        INSERT OR IGNORE INTO events
        (id, message_id, company, company_source, role, status, subject, from_name,
         from_email, occurred_at, url, snippet, confidence, matched_keywords, source,
         category, classified_by, llm_reason, email_type, group_title, webmail_url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            event["id"],
            event["message_id"],
            event["company"],
            event["company_source"],
            event["role"],
            event["status"],
            event["subject"],
            event["from_name"],
            event["from_email"],
            event["occurred_at"],
            event["url"],
            event["snippet"],
            event["confidence"],
            json.dumps(event["matched_keywords"], ensure_ascii=False),
            event["source"],
            event.get("category") or "",
            event.get("classified_by") or "rules",
            event.get("llm_reason") or "",
            event.get("email_type") or "application",
            event.get("group_title") or "",
            event.get("webmail_url") or "",
        ),
    )
    connection.commit()
    return cursor.rowcount > 0


def list_events(connection: sqlite3.Connection, limit: int = 200, since: str = "") -> list[dict]:
    if since:
        rows = connection.execute(
            "SELECT * FROM events WHERE occurred_at >= ? ORDER BY occurred_at DESC LIMIT ?",
            (since, limit),
        ).fetchall()
    else:
        rows = connection.execute(
            "SELECT * FROM events ORDER BY occurred_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    events = []
    for row in rows:
        item = dict(row)
        try:
            item["matched_keywords"] = json.loads(item.get("matched_keywords") or "[]")
        except Exception:
            item["matched_keywords"] = []
        events.append(item)
    return events


def count_events(connection: sqlite3.Connection) -> int:
    row = connection.execute("SELECT COUNT(*) AS total FROM events").fetchone()
    return row["total"] if row else 0


def send_client_id(client) -> dict:
    """Some Chinese IMAP providers (notably 163) require an ID command."""
    # imaplib does not know the ID command by default. Without this entry,
    # _simple_command raises KeyError before anything is sent to the server.
    if "ID" not in imaplib.Commands:
        imaplib.Commands["ID"] = ("AUTH", "SELECTED")
    try:
        status, data = client._simple_command(
            "ID",
            '("name" "JobLedger" "version" "1.0.0" "vendor" "local")',
        )
        untagged_error = ""
        try:
            client._untagged_response(status, data, "ID")
        except Exception as error:
            untagged_error = str(error)
        return {
            "ok": status == "OK",
            "status": status,
            "data": data,
            "error": untagged_error,
        }
    except Exception as error:
        return {"ok": False, "status": "EXCEPTION", "data": None, "error": str(error)}


def list_mailboxes(client) -> list[str]:
    try:
        status, data = client.list()
        if status != "OK":
            return []
        names: list[str] = []
        for item in data or []:
            if isinstance(item, bytes):
                text = item.decode("utf-8", errors="replace")
            else:
                text = str(item)
            match = re.search(r'"([^"]*)"\s*$', text)
            if match:
                names.append(match.group(1))
            else:
                names.append(text.rsplit(" ", 1)[-1])
        return names
    except Exception:
        return []


def select_mailbox(client, mailbox: str) -> str:
    id_result = send_client_id(client)
    candidates: list[str] = []
    for name in (mailbox, "INBOX", "Inbox"):
        if name and name not in candidates:
            if not name.isascii():
                continue
            candidates.append(name)

    attempts: list[str] = []
    # Some servers reject EXAMINE (readonly=True) but accept SELECT.
    # Fetching uses BODY.PEEK[] below, so SELECT does not mark mail as read.
    for readonly in (True, False):
        for name in candidates:
            try:
                status, data = client.select(name, readonly=readonly)
                if status == "OK":
                    return name
                attempts.append(f"{name} readonly={readonly}: {status} {data!r}")
            except Exception as error:
                attempts.append(f"{name} readonly={readonly}: {error}")

    folders = list_mailboxes(client)
    available = "、".join(folders[:12]) if folders else "无法读取文件夹列表"
    id_text = (
        f"{id_result.get('status')} {id_result.get('data')!r}"
        + (f" ({id_result.get('error')})" if id_result.get("error") else "")
    )
    raise ConfigError(
        f"无法打开邮箱文件夹：{mailbox or 'INBOX'}。"
        f"ID 命令：{'成功' if id_result.get('ok') else '失败'}，{id_text}。"
        f"尝试结果：{' | '.join(attempts) or '无'}。"
        f"服务器可用文件夹：{available}"
    )


def sync_mailbox(config: dict) -> dict:
    if not is_configured(config):
        raise ConfigError("还没有配置 IMAP：请填写 imap_host、username、password（授权码）")
    connection = open_db(config["db_path"])
    client = None
    scanned = 0
    inserted = 0
    ignored = 0
    try:
        client = imaplib.IMAP4_SSL(config["imap_host"], config["imap_port"], timeout=30)
        client.login(config["username"], config["password"])
        selected_mailbox = select_mailbox(client, config["mailbox"])

        since = (dt.date.today() - dt.timedelta(days=max(1, config["search_days"]))).strftime("%d-%b-%Y")
        status, data = client.search(None, "SINCE", since)
        if status != "OK":
            raise ConfigError("IMAP 搜索失败")
        ids = (data[0] or b"").split()
        ids = ids[-max(1, config["max_messages"]):]
        for message_id in reversed(ids):
            try:
                status, fetched = client.fetch(message_id, "(BODY.PEEK[])")
                if status != "OK" or not fetched:
                    continue
                raw = next((part[1] for part in fetched if isinstance(part, tuple) and len(part) > 1), None)
                if not raw:
                    continue
                scanned += 1
                event = parse_email(raw, llm_config=config)
                event["webmail_url"] = webmail_link(config, event["message_id"], event["subject"])
                if not event.get("relevant"):
                    ignored += 1
                    continue
                if insert_event(connection, event):
                    inserted += 1
            except Exception:
                continue

        set_meta(connection, "last_sync", dt.datetime.now(dt.timezone.utc).isoformat())
        set_meta(connection, "last_error", "")
        set_meta(connection, "last_scanned", str(scanned))
        set_meta(connection, "last_inserted", str(inserted))
        set_meta(connection, "last_ignored", str(ignored))
        set_meta(connection, "selected_mailbox", selected_mailbox)
        return {
            "scanned": scanned,
            "inserted": inserted,
            "ignored": ignored,
            "total": count_events(connection),
            "mailbox": selected_mailbox,
            "last_sync": get_meta(connection, "last_sync"),
        }
    finally:
        if client is not None:
            try:
                client.logout()
            except Exception:
                pass
        connection.close()


SYNC_LOCK = threading.Lock()


def sync_with_lock(config: dict) -> dict:
    if not SYNC_LOCK.acquire(blocking=False):
        raise ConfigError("正在同步，请稍后再试")
    try:
        return sync_mailbox(config)
    except Exception as error:
        try:
            connection = open_db(config["db_path"])
            set_meta(connection, "last_error", str(error))
            connection.close()
        except Exception:
            pass
        raise
    finally:
        SYNC_LOCK.release()


CONFIG_WRITE_LOCK = threading.Lock()


def public_config(config: dict) -> dict:
    return {
        "ok": True,
        "configured": is_configured(config),
        "imap_host": config.get("imap_host", ""),
        "imap_port": config.get("imap_port", 993),
        "username": config.get("username", ""),
        "mailbox": config.get("mailbox", "INBOX"),
        "search_days": config.get("search_days", 90),
        "max_messages": config.get("max_messages", 300),
        "token_set": bool(config.get("token")),
        "llm_enabled": bool(config.get("llm_enabled")),
        "llm_base_url": config.get("llm_base_url", ""),
        "llm_model": config.get("llm_model", ""),
        "llm_key_set": bool(config.get("llm_api_key")),
    }


def save_config(config: dict) -> None:
    path = Path(config["config_path"])
    payload = {key: config[key] for key in DEFAULT_CONFIG if key in config and key != "config_path"}
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def apply_config_updates(config: dict, updates: dict) -> dict:
    if not isinstance(updates, dict):
        raise ConfigError("配置格式不正确")
    with CONFIG_WRITE_LOCK:
        for key in ("imap_host", "username", "mailbox"):
            if key in updates:
                value = str(updates[key] or "").strip()
                if value:
                    config[key] = value
        if "password" in updates and str(updates["password"] or "").strip():
            config["password"] = str(updates["password"]).strip()
        if "imap_port" in updates:
            try:
                config["imap_port"] = int(updates["imap_port"])
            except (TypeError, ValueError):
                raise ConfigError("IMAP 端口必须是数字")
        if "search_days" in updates:
            try:
                config["search_days"] = max(1, int(updates["search_days"]))
            except (TypeError, ValueError):
                raise ConfigError("同步天数必须是数字")
        if "max_messages" in updates:
            try:
                config["max_messages"] = max(1, int(updates["max_messages"]))
            except (TypeError, ValueError):
                raise ConfigError("最大邮件数必须是数字")
        for key in ("llm_base_url", "llm_model"):
            if key in updates:
                config[key] = str(updates[key] or "").strip()
        if "llm_api_key" in updates and str(updates["llm_api_key"] or "").strip():
            config["llm_api_key"] = str(updates["llm_api_key"]).strip()
        if "llm_enabled" in updates:
            config["llm_enabled"] = bool(updates["llm_enabled"])
        if not config.get("mailbox"):
            config["mailbox"] = "INBOX"
        save_config(config)
        return public_config(config)


def test_connection(config: dict) -> dict:
    if not is_configured(config):
        raise ConfigError("还没有填写 IMAP 地址、账号和授权码")
    client = None
    try:
        client = imaplib.IMAP4_SSL(config["imap_host"], config["imap_port"], timeout=30)
        client.login(config["username"], config["password"])
        selected = select_mailbox(client, config["mailbox"])
        return {"mailbox": selected, "folders": list_mailboxes(client)[:20]}
    finally:
        if client is not None:
            try:
                client.logout()
            except Exception:
                pass


def status_payload(config: dict) -> dict:
    connection = open_db(config["db_path"])
    try:
        return {
            "ok": True,
            "service": "jobledger-mail",
            "version": "0.3.0",
            "configured": is_configured(config),
            "imap_host": config["imap_host"],
            "username": config["username"],
            "mailbox": config["mailbox"],
            "event_count": count_events(connection),
            "last_sync": get_meta(connection, "last_sync"),
            "last_error": get_meta(connection, "last_error"),
            "last_scanned": get_meta(connection, "last_scanned"),
            "last_inserted": get_meta(connection, "last_inserted"),
            "last_ignored": get_meta(connection, "last_ignored"),
            "selected_mailbox": get_meta(connection, "selected_mailbox"),
        }
    finally:
        connection.close()


def make_handler(config: dict):
    class Handler(BaseHTTPRequestHandler):
        server_version = "JobLedgerMail/0.1"

        def _cors(self) -> None:
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-JobLedger-Token")
            self.send_header("Access-Control-Allow-Private-Network", "true")

        def _json(self, code: int, payload: dict) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self._cors()
            self.end_headers()
            self.wfile.write(body)

        def _authorized(self) -> bool:
            token = config.get("token") or ""
            if not token:
                return True
            return self.headers.get("X-JobLedger-Token", "") == token

        def do_OPTIONS(self) -> None:
            self.send_response(204)
            self._cors()
            self.end_headers()

        def do_GET(self) -> None:
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path == "/health":
                self._json(200, {
                    "ok": True,
                    "service": "jobledger-mail",
                    "version": "0.3.0",
                    "configured": is_configured(config),
                })
                return
            if not self._authorized():
                self._json(401, {"ok": False, "error": "令牌不正确"})
                return
            if parsed.path == "/status":
                self._json(200, status_payload(config))
                return
            if parsed.path == "/config":
                self._json(200, public_config(config))
                return
            if parsed.path == "/events":
                query = urllib.parse.parse_qs(parsed.query)
                try:
                    limit = min(500, max(1, int(query.get("limit", ["200"])[0])))
                except ValueError:
                    limit = 200
                since = query.get("since", [""])[0]
                connection = open_db(config["db_path"])
                try:
                    events = list_events(connection, limit=limit, since=since)
                    payload = {
                        "ok": True,
                        "events": events,
                        "count": len(events),
                        "last_sync": get_meta(connection, "last_sync"),
                    }
                finally:
                    connection.close()
                self._json(200, payload)
                return
            self._json(404, {"ok": False, "error": "not found"})

        def do_POST(self) -> None:
            parsed = urllib.parse.urlparse(self.path)
            if not self._authorized():
                self._json(401, {"ok": False, "error": "令牌不正确"})
                return
            if parsed.path == "/config":
                try:
                    length = int(self.headers.get("Content-Length", "0") or 0)
                    if length > 20000:
                        raise ConfigError("配置内容过大")
                    raw = self.rfile.read(length) if length else b"{}"
                    data = json.loads(raw.decode("utf-8") or "{}")
                    test = bool(data.pop("test", False))
                    saved = apply_config_updates(config, data)
                    result = {"ok": True, "config": saved, "test": None}
                    if test:
                        try:
                            test_result = {"ok": True, **test_connection(config)}
                        except Exception as error:
                            test_result = {"ok": False, "error": str(error)}
                        if llm_is_enabled(config):
                            test_result["llm"] = llm_test(config)
                        result["test"] = test_result
                    self._json(200, result)
                except ConfigError as error:
                    self._json(400, {"ok": False, "error": str(error)})
                except Exception as error:
                    self._json(500, {"ok": False, "error": str(error)})
                return
            if parsed.path == "/events/clear":
                connection = open_db(config["db_path"])
                try:
                    cleared = connection.execute("DELETE FROM events").rowcount
                    connection.commit()
                finally:
                    connection.close()
                self._json(200, {"ok": True, "cleared": cleared})
                return
            if parsed.path == "/sync":
                try:
                    result = sync_with_lock(config)
                    self._json(200, {"ok": True, **result})
                except ConfigError as error:
                    self._json(400, {"ok": False, "error": str(error)})
                except Exception as error:
                    self._json(500, {"ok": False, "error": str(error)})
                return
            self._json(404, {"ok": False, "error": "not found"})

        def log_message(self, fmt: str, *args) -> None:
            # In a PyInstaller --noconsole build sys.stderr is None. If
            # BaseHTTPRequestHandler tries to log through it, send_response()
            # raises before writing the HTTP headers and the client sees an
            # empty reply. Silently skip logging when there is no console.
            stream = getattr(sys, "stderr", None)
            if stream is None:
                return
            try:
                stream.write("[jobledger-mail] " + (fmt % args) + "\n")
            except Exception:
                pass

    return Handler


def main() -> int:
    parser = argparse.ArgumentParser(description="JobLedger local IMAP bridge")
    parser.add_argument("--config", default=str(BASE_DIR / "config.json"), help="配置文件路径")
    parser.add_argument("--once", action="store_true", help="只同步一次，不启动 HTTP 服务")
    parser.add_argument("--port", type=int, default=None, help="覆盖 HTTP 端口")
    args = parser.parse_args()

    try:
        config = load_config(Path(args.config))
    except ConfigError as error:
        print(error, file=sys.stderr)
        return 2
    if args.port:
        config["http_port"] = args.port

    if args.once:
        try:
            result = sync_with_lock(config)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0
        except Exception as error:
            print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
            return 1

    host = config["http_host"] or "127.0.0.1"
    port = config["http_port"]
    server = ThreadingHTTPServer((host, port), make_handler(config))
    print(f"JobLedger mail bridge: http://{host}:{port}")
    print(f"config: {config['config_path']}")
    print(f"IMAP configured: {is_configured(config)}")
    if not is_configured(config):
        print("提示：先填写 config.json 里的 IMAP 账号和授权码，再点看板里的「立即同步」。")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
