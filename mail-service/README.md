# 投递簿 · 本地邮件服务

把招聘通知邮件变成投递看板里的状态建议。

这是一个只在本机运行的小服务：

```text
IMAP 邮箱  →  jobledger_mail.py  →  http://127.0.0.1:8787  →  浏览器扩展看板
```

服务本身使用 Python 标准库；PDF 附件解析使用随包附带的 `vendor/pypdf`，不需要用户安装。默认不把邮件内容上传到任何云端；只有你启用「大模型识别」后，邮件正文才会发送到你填写的模型 API。

## Windows 托盘版（推荐）

发布包根目录 `JobLedgerTray\JobLedgerTray.exe` 已经内置 Python 和服务代码。用户双击一次，右下角出现托盘图标即可，不需要命令行、不需要安装 Python。

- 扩展看板 →「邮件同步」里直接填 IMAP 服务器、账号、授权码；
- 保存后托盘服务写入 `%LOCALAPPDATA%\JobLedger\config.json`；
- 托盘菜单：立即同步、开机启动、退出；
- 浏览器关闭后，托盘仍可继续同步（只要电脑和托盘程序在运行）。

`config.json`、`jobledger-mail.db`、`tray-error.log` 都在 `%LOCALAPPDATA%\JobLedger`。

## 大模型识别（可选）

服务支持任何 **OpenAI 兼容** 的 `/chat/completions` 接口。用户自己提供：

```json
{
  "llm_enabled": true,
  "llm_base_url": "https://api.deepseek.com/v1",
  "llm_api_key": "你的 API Key",
  "llm_model": "deepseek-chat",
  "llm_timeout": 25
}
```

Base URL 一般填到 `/v1`；如果填的是完整的 `/chat/completions` 也可以。常见的 DeepSeek、OpenAI 兼容网关、本地 vLLM/Ollama 网关都可以。

启用后：

- 招聘相关性邮件会先发给你填的模型，让它输出固定状态、分类和邮件类型；
- 状态枚举：`applied / screening / assessment / written / interview1 / interview2 / interview3 / hr / offer / rejected / unknown`；
- 分类枚举：`application / screening / assessment / written / interview / offer / rejection / other`；
- 邮件类型：`application`（有明确岗位的投递流程）或 `other`（信息确认等其他公司邮件，或没有岗位信息的投递流程）；
- `other` 会给一个 4-12 字的 `group_title` 摘要，扩展用它放在「其他邮件」栏；
- 模型失败、超时或返回格式不对时，自动回退关键词规则；
- 邮件正文会离开本机发送到你的模型 API，请确认服务商和隐私政策；
- API Key 只保存在本机的 `config.json`，`/config` 接口不会把它返回给扩展。

## 它做什么

- 连接你的 IMAP 邮箱，读取最近一段时间的邮件；
- 先做招聘相关性过滤，只把看起来像投递/面试/笔试/测评/录用通知的邮件入库，个人邮件会跳过；
- 邮件正文没有内容时，会读取 PDF 附件正文并合并到正文，再走同一套识别流程；
- 识别公司、岗位、状态（投递成功 / 简历通过 / 测评 / 笔试 / 面试 / Offer / 未通过）；
- 从邮件里提取预约链接、笔试链接或投递链接；
- 把结果写入本地 SQLite（`jobledger-mail.db`）；
- 通过本地 HTTP 接口提供给扩展，扩展会按公司/岗位匹配已有记录并更新状态。

## 不支持什么

- 不读取微信、短信、电话、招聘平台站内信；
- 不代登录、不自动投递；
- 不解析附件里的 PDF/Word（只读正文和 HTML 链接）；
- 只扫描一个邮箱文件夹（默认 `INBOX`），不会自动遍历“垃圾邮件/广告邮件”；
- 邮件分类是启发式的。置信度低的邮件可能会识别错，扩展里可以手动改。

## 快速开始

### 1. 确认 Python

需要 Python 3.10 或更高版本：

```bash
python --version
```

### 2. 准备邮箱

这个服务使用 IMAP + 授权码，不是你的网页登录密码。

**QQ 邮箱**

1. 网页版 QQ 邮箱 → 设置 → 账户；
2. 找到“POP3/IMAP/SMTP/Exchange/CardDAV/CalDAV 服务”；
3. 开启 IMAP/SMTP 服务；
4. 生成“授权码”，复制下来。

**163 邮箱**

1. 网页版 163 邮箱 → 设置 → POP3/SMTP/IMAP；
2. 开启 IMAP/SMTP 服务；
3. 设置客户端授权密码。

**Gmail**

1. Google 账号开启两步验证；
2. 生成“应用专用密码”；
3. `imap_host` 用 `imap.gmail.com`，`username` 用完整 Gmail 地址，`password` 用应用专用密码。

**Outlook / Microsoft 365**

部分账号已禁用基础认证，可能无法用“账号 + 密码”直接登录 IMAP；如果开启了两步验证，优先尝试应用密码。若提示认证失败，这个 MVP 暂不支持 OAuth，建议先用 QQ/163 邮箱。

### 3. 写配置

```bash
cd mail-service
cp config.example.json config.json
```

编辑 `config.json`：

```json
{
  "imap_host": "imap.qq.com",
  "imap_port": 993,
  "username": "you@qq.com",
  "password": "你的授权码",
  "mailbox": "INBOX",
  "search_days": 365,
  "max_messages": 500,
  "http_host": "127.0.0.1",
  "http_port": 8787,
  "token": "自己生成的一串随机字符串",
  "db_path": "jobledger-mail.db"
}
```

首次同步会读取 `search_days` 天内最近 `max_messages` 封邮件；大模型需要逐封判断，邮件多时第一次会比较慢。

`token` 用于保护本地接口，扩展里要填同一个值。可以留空，但不建议。

`config.json` 包含邮箱授权码，**不要提交到 Git、不要发给别人**。

### 4. 启动服务

Windows 可以直接双击 `start.bat`；如果 `.bat` 被安全软件拦截，可以试 `start.cmd`。macOS/Linux 可以运行 `./start.sh`。也可以手动执行：

```bash
python jobledger_mail.py
```

如果双击没有反应，运行 `diagnose.bat`，它会在同目录生成 `diagnose.txt`，里面包含 Python 路径、版本、配置文件和端口占用情况。

如果看板提示 `无法打开邮箱文件夹：INBOX`：

```bash
python diagnose_imap.py
```

它会打印服务器返回的文件夹列表，并分别用只读 `EXAMINE` 和 `SELECT` 测试 `INBOX`、`Inbox`，同时打印 `ID` 命令的详细结果。163 邮箱常见原因是需要先发 IMAP `ID` 命令，v0.2.5 已自动处理；如果仍然失败，把 `diagnose_imap.py` 的输出发我。

看到：

```text
JobLedger mail bridge: http://127.0.0.1:8787
IMAP configured: True
```

就说明服务起来了。先手动同步一次：

```bash
python jobledger_mail.py --once
```

或者保持服务运行，在扩展看板里点「立即同步」。

### 5. 在扩展里启用

1. 打开投递看板；
2. 点右上角「邮件同步」；
3. 服务地址填 `http://127.0.0.1:8787`；
4. 令牌填 `config.json` 里的 `token`；
5. 点「测试连接」；
6. 勾选「启用自动同步」，保存。

启用后，扩展每 5 分钟调用一次本地服务。服务会先同步邮箱，再把事件返回给看板。

## 接口

服务只监听 `127.0.0.1`，默认端口 `8787`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查，不需要令牌 |
| GET | `/config` | 当前 IMAP/大模型配置（不含密码和 Key） |
| POST | `/config` | 保存 IMAP/大模型配置，可带 `"test": true` 测试登录和大模型 |
| GET | `/status` | 配置状态、上次同步、事件数量 |
| GET | `/events?limit=200&since=...` | 已解析的邮件事件 |
| POST | `/sync` | 立即拉取邮箱并解析 |
| POST | `/events/clear` | 清空邮件事件（不删除投递记录），用于重新识别 |

如果配置了 `token`，除 `/health` 外的请求都要带：

```text
X-JobLedger-Token: 你的 token
```

## 数据

- 托盘版：`%LOCALAPPDATA%\JobLedger\jobledger-mail.db`
- 手动版：`mail-service/jobledger-mail.db`
- 表：`events`（解析后的事件）、`meta`（上次同步时间等）
- 删除数据：停止服务，删除 `jobledger-mail.db` 即可

## 开发与测试

```bash
cd mail-service
python -m unittest discover -s tests -v
```

测试覆盖：

- 面试、Offer、拒绝信的识别；
- “面试未通过”优先识别为拒绝；
- HTML 邮件里的链接提取；
- ATS 发件人不被误识别为公司名；
- IMAP `ID` 命令注册、`SELECT` 回退和配置 API。

构建托盘 exe（需要 `pystray`、`pyinstaller`）：

```powershell
pip install pystray pyinstaller
python -m PyInstaller --noconfirm --clean --onedir --noconsole `
  --name JobLedgerTray --icon jobledger.ico `
  --paths . --collect-all pystray --collect-all PIL tray_app.py
```

生成 `dist/JobLedgerTray/` 文件夹，把整个文件夹复制到发布包根目录。onedir 不依赖临时目录解压，比 onefile 更适合直接分发。

## 安全建议

- 只在本机运行，不要把 `8787` 端口暴露到公网；
- 设置 `token`，避免本机其他程序随便读接口；
- 使用邮箱授权码/应用专用密码，不要使用网页登录密码；
- 不用的時候停掉服务；
- 换邮箱或授权码失效时，更新 `config.json` 后重启服务。
