import datetime as dt
import sys
import unittest
from unittest.mock import patch
from email import policy
from email.message import EmailMessage
from email.utils import format_datetime, formataddr
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import jobledger_mail as mail  # noqa: E402
from jobledger_mail import classify, parse_email  # noqa: E402
from pdf_fixture import make_pdf  # noqa: E402


def build_email(subject: str, from_name: str, from_email: str, body: str, html: str = "", pdf: bytes | None = None) -> bytes:
    message = EmailMessage(policy=policy.SMTPUTF8)
    message["Subject"] = subject
    message["From"] = formataddr((from_name, from_email))
    message["To"] = "me@example.com"
    message["Date"] = format_datetime(dt.datetime(2026, 10, 20, 9, 30, tzinfo=dt.timezone.utc))
    message["Message-ID"] = "<" + subject.replace(" ", "-") + "@example.com>"
    message.set_content(body)
    if html:
        message.add_alternative(html, subtype="html")
    if pdf:
        message.add_attachment(pdf, maintype="application", subtype="pdf", filename="notice.pdf")
    return message.as_bytes()


class ParserTests(unittest.TestCase):
    def test_interview_email(self):
        raw = build_email(
            "【星河数据】数据分析师 面试邀请",
            "星河数据招聘",
            "no-reply@mokahr.com",
            "您好，您的简历已通过初筛。\n岗位：数据分析师\n面试时间：10 月 24 日 14:00\n请点击 https://example.com/interview/abc 预约面试。",
        )
        event = parse_email(raw)
        self.assertEqual(event["company"], "星河数据")
        self.assertEqual(event["role"], "数据分析师")
        self.assertEqual(event["status"], "interview")
        self.assertEqual(event["url"], "https://example.com/interview/abc")
        self.assertGreaterEqual(event["confidence"], 0.7)

    def test_offer_email(self):
        raw = build_email(
            "录用通知书 - 产品经理",
            "北辰智能 HR",
            "hr@beichen.com",
            "恭喜您通过全部面试，现发放录用通知。\n岗位：产品经理\n请查收附件中的 offer letter。",
        )
        event = parse_email(raw)
        self.assertEqual(event["company"], "北辰智能")
        self.assertEqual(event["role"], "产品经理")
        self.assertEqual(event["status"], "offer")

    def test_company_from_long_sentence_subject(self):
        raw = build_email(
            "请于今日完成你在梅赛德斯-奔驰的职位申请",
            "梅赛德斯-奔驰招聘",
            "no-reply@mokahr.com",
            "请完成职位申请。岗位：数据分析师。",
        )
        event = parse_email(raw)
        self.assertEqual(event["company"], "梅赛德斯-奔驰")

    def test_role_from_application_body(self):
        raw = build_email(
            "XD Inc.感谢您的投递！",
            "XD Inc.",
            "noreply-hire@mail.feishu.cn",
            "亲爱的王雨\n感谢您关注并投递简历至心动网络 /TapTap！我们已成功收到您对我们TapTap 游戏开发实习生（上海）的申请。",
        )
        event = parse_email(raw)
        self.assertEqual(event["role"], "游戏开发实习生")
        self.assertEqual(event["company"], "XD Inc.")

    def test_body_role_wins_over_title(self):
        raw = build_email(
            "数据分析师面试邀请",
            "某公司招聘",
            "hr@example.com",
            "感谢您申请我们的产品经理岗位，面试时间另行通知。",
        )
        event = parse_email(raw)
        self.assertEqual(event["role"], "产品经理")

    def test_title_role_is_not_used(self):
        raw = build_email(
            "数据分析师面试邀请",
            "某公司招聘",
            "hr@example.com",
            "感谢您的关注，具体安排稍后通知。",
        )
        event = parse_email(raw)
        self.assertEqual(event["role"], "")
        self.assertEqual(event["email_type"], "other")

    def test_pdf_text_is_extracted(self):
        self.assertIsNotNone(mail.PdfReader)
        text = mail.extract_pdf_text(make_pdf("Position: Data Analyst"))
        self.assertIn("Data Analyst", text)

    def test_pdf_attachment_body_is_used(self):
        raw = build_email(
            "面试通知",
            "某公司招聘",
            "hr@example.com",
            "请查收附件。",
            pdf=b"%PDF-1.4 fake",
        )
        with patch("jobledger_mail.extract_pdf_text", return_value="岗位：游戏开发实习生\n面试时间：10 月 24 日"):
            event = parse_email(raw)
        self.assertEqual(event["role"], "游戏开发实习生")
        self.assertEqual(event["email_type"], "application")
        self.assertEqual(event["status"], "interview")

    def test_application_process_email_without_role_is_other(self):
        raw = build_email(
            "简历筛选结果通知 | 沐晨科技 2027 校园招聘",
            "沐晨科技招聘",
            "no-reply@mokahr.com",
            "您的简历已收到，我们会尽快筛选。",
        )
        event = parse_email(raw)
        self.assertEqual(event["company"], "沐晨科技")
        self.assertEqual(event["role"], "")
        self.assertEqual(event["email_type"], "other")

    def test_rejection_email(self):
        raw = build_email(
            "感谢您应聘云帆网络前端工程师",
            "云帆网络",
            "no-reply@zhiye.com",
            "感谢您对云帆网络的关注。很遗憾，您的简历与本岗位暂不匹配，本次未能进入下一轮。岗位：前端工程师。",
        )
        event = parse_email(raw)
        self.assertEqual(event["company"], "云帆网络")
        self.assertEqual(event["role"], "前端工程师")
        self.assertEqual(event["status"], "rejected")

    def test_rejection_beats_interview_keyword(self):
        status, _, _ = classify("面试未通过通知", "很遗憾，面试未通过。")
        self.assertEqual(status, "rejected")

    def test_not_hired_beats_offer_keyword(self):
        status, _, _ = classify("录用结果通知", "很遗憾，本次不录用。")
        self.assertEqual(status, "rejected")

    def test_html_link(self):
        raw = build_email(
            "笔试通知 - 后端工程师",
            "远山制造",
            "no-reply@hotjob.cn",
            "请查收笔试通知。岗位：后端工程师。",
            html='<p>岗位：后端工程师</p><p>请点击 <a href="https://example.com/apply/1">开始笔试</a></p>',
        )
        event = parse_email(raw)
        self.assertEqual(event["status"], "written")
        self.assertEqual(event["role"], "后端工程师")
        self.assertEqual(event["url"], "https://example.com/apply/1")

    def test_short_hr_email_is_relevant(self):
        raw = build_email(
            "面试",
            "HR",
            "hr@example.com",
            "明天下午 3 点来面试，地点在 5 楼会议室。",
        )
        event = parse_email(raw)
        self.assertTrue(event["relevant"])
        self.assertEqual(event["email_type"], "other")
        self.assertEqual(event["status"], "unknown")

    def test_llm_can_override_rule_status(self):
        raw = build_email(
            "【星河数据】数据分析师 面试邀请",
            "星河数据招聘",
            "no-reply@mokahr.com",
            "岗位：数据分析师。请点击 https://example.com/interview/abc 预约。",
        )
        config = {
            "llm_enabled": True,
            "llm_base_url": "https://api.example.com/v1",
            "llm_api_key": "key",
            "llm_model": "model",
            "llm_timeout": 5,
        }
        with patch("jobledger_mail.classify_with_llm", return_value=({
            "is_recruitment": True,
            "status": "offer",
            "category": "offer",
            "company": "星河数据",
            "role": "数据分析师",
            "confidence": 0.96,
            "reason": "邮件明确写录用",
        }, "")):
            event = parse_email(raw, llm_config=config)
        self.assertEqual(event["status"], "offer")
        self.assertEqual(event["category"], "offer")
        self.assertEqual(event["classified_by"], "llm")

    def test_llm_json_parser(self):
        config = {
            "llm_enabled": True,
            "llm_base_url": "https://api.example.com/v1",
            "llm_api_key": "key",
            "llm_model": "model",
            "llm_timeout": 5,
        }
        with patch("jobledger_mail.llm_chat", return_value='```json\n{"is_recruitment": true, "status": "written", "category": "written", "company": "远山制造", "role": "后端工程师", "confidence": 0.9, "reason": "笔试通知"}\n```'):
            result, error = mail.classify_with_llm(config, "笔试通知", "请参加笔试", "HR", "hr@example.com")
        self.assertEqual(error, "")
        self.assertEqual(result["status"], "written")
        self.assertEqual(result["company"], "远山制造")

    def test_personal_email_is_not_relevant(self):
        raw = build_email(
            "周末聚餐",
            "张三",
            "zhangsan@example.com",
            "这周末一起吃饭吗？地点还是上次那家。",
        )
        event = parse_email(raw)
        self.assertFalse(event["relevant"])

    def test_ats_sender_does_not_become_company(self):
        raw = build_email(
            "面试邀请",
            "Moka",
            "no-reply@mokahr.com",
            "岗位：后端工程师。请点击 https://example.com/interview/2 预约。",
        )
        event = parse_email(raw)
        self.assertEqual(event["company"], "待确认")
        self.assertEqual(event["role"], "后端工程师")


if __name__ == "__main__":
    unittest.main()
