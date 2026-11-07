import sys
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import jobledger_mail as mail  # noqa: E402
from test_parser import build_email  # noqa: E402


class FakeIMAP:
    raw = build_email(
        "【星河数据】数据分析师 面试邀请",
        "星河数据招聘",
        "no-reply@mokahr.com",
        "岗位：数据分析师。请点击 https://example.com/interview/abc 预约。",
    )

    def __init__(self, *args, **kwargs):
        pass

    def login(self, username, password):
        return "OK", [b""]

    def _simple_command(self, *args):
        return "OK", [b""]

    def _untagged_response(self, *args):
        return "OK", [b""]

    def list(self):
        return "OK", [b'(\\HasNoChildren) "/" "INBOX"']

    def select(self, mailbox, readonly=True):
        return "OK", [b"1"]

    def search(self, charset, *criteria):
        return "OK", [b"1"]

    def fetch(self, message_id, query):
        return "OK", [(b"1 (RFC822)", self.raw)]

    def logout(self):
        return "BYE", []


class FakeSelectOnlyIMAP(FakeIMAP):
    def select(self, mailbox, readonly=True):
        if readonly:
            return "NO", [b"EXAMINE not allowed"]
        return "OK", [b"1"]


class SyncTests(unittest.TestCase):
    def test_send_client_id_registers_imap_command(self):
        result = mail.send_client_id(FakeIMAP())
        self.assertTrue(result["ok"])
        self.assertIn("ID", mail.imaplib.Commands)

    def test_select_mailbox_falls_back_to_select_mode(self):
        with patch("jobledger_mail.imaplib.IMAP4_SSL", return_value=FakeSelectOnlyIMAP()):
            client = mail.imaplib.IMAP4_SSL()
            selected = mail.select_mailbox(client, "INBOX")
        self.assertEqual(selected, "INBOX")

    def test_sync_inserts_once_and_deduplicates(self):
        db_path = Path(__file__).resolve().parent / ("test-sync-" + uuid.uuid4().hex + ".db")
        config = {
            "imap_host": "imap.example.com",
            "imap_port": 993,
            "username": "me@example.com",
            "password": "secret",
            "mailbox": "INBOX",
            "search_days": 30,
            "max_messages": 10,
            "db_path": str(db_path),
        }
        try:
            with patch("jobledger_mail.imaplib.IMAP4_SSL", return_value=FakeIMAP()):
                first = mail.sync_mailbox(config)
            self.assertEqual(first["scanned"], 1)
            self.assertEqual(first["inserted"], 1)
            self.assertEqual(first["total"], 1)

            with patch("jobledger_mail.imaplib.IMAP4_SSL", return_value=FakeIMAP()):
                second = mail.sync_mailbox(config)
            self.assertEqual(second["inserted"], 0)
            self.assertEqual(second["total"], 1)

            connection = mail.open_db(config["db_path"])
            try:
                events = mail.list_events(connection)
                self.assertEqual(len(events), 1)
                self.assertEqual(events[0]["company"], "星河数据")
                self.assertEqual(events[0]["status"], "interview")
            finally:
                connection.close()
        finally:
            try:
                db_path.unlink()
            except FileNotFoundError:
                pass


if __name__ == "__main__":
    unittest.main()
