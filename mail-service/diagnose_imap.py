#!/usr/bin/env python3
"""Print the IMAP folder list and test selecting the configured mailbox."""

from __future__ import annotations

import imaplib
import sys
from pathlib import Path

from jobledger_mail import is_configured, list_mailboxes, load_config, send_client_id


def main() -> int:
    config_path = Path(__file__).resolve().with_name("config.json")
    try:
        config = load_config(config_path)
    except Exception as error:
        print("Cannot load config:", error)
        return 2

    print("Config:", config_path)
    print("IMAP host:", config["imap_host"])
    print("Username:", config["username"])
    print("Configured mailbox:", config["mailbox"])
    if not is_configured(config):
        print("IMAP is not fully configured. Fill imap_host/username/password in config.json.")
        return 1

    client = None
    try:
        client = imaplib.IMAP4_SSL(config["imap_host"], config["imap_port"], timeout=30)
        print("Login...")
        client.login(config["username"], config["password"])
        print("Login OK")
        print("Capabilities:", " ".join(client.capabilities))

        id_result = send_client_id(client)
        print("ID command:", id_result)
        print("Folders:")
        folders = list_mailboxes(client)
        for folder in folders:
            print("  -", folder)
        if not folders:
            print("  (no folders returned)")

        for readonly in (True, False):
            for name in [config["mailbox"], "INBOX", "Inbox"]:
                if not name or not name.isascii():
                    continue
                try:
                    status, data = client.select(name, readonly=readonly)
                    print("SELECT", repr(name), "readonly=" + str(readonly), "->", status, data)
                except Exception as error:
                    print("SELECT", repr(name), "readonly=" + str(readonly), "failed:", error)
    except Exception as error:
        print("IMAP error:", error)
        return 1
    finally:
        if client is not None:
            try:
                client.logout()
            except Exception:
                pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
