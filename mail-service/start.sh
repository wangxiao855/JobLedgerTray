#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
if [ ! -f config.json ]; then
  echo "还没有 config.json。"
  echo "请先把 config.example.json 复制为 config.json，并填写邮箱账号、授权码和 token。"
  exit 1
fi
python3 jobledger_mail.py
