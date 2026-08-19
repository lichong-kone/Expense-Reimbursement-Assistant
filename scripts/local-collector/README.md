# 本地自包含报销采集器

**无需 Web UI、无需 REBU 服务器、无需数据库**。从邮箱/文件夹自动采集发票 → 提取 → 政策审核 → 生成正式《费用报销单》Excel。

## 架构

```
┌─────────────┐     ┌─────────────┐
│ local 填充器 │────▶│             │
│ (用户手放文件)│     │  inboxDir/  │
└─────────────┘     │             │
                    │  (统一 inbox)│
┌─────────────┐     │             │
│ mailbox填充器│────▶│             │
│ (IMAP 增量) │     └──────┬──────┘
└─────────────┘            │
                           ▼
                    ┌─────────────┐
                    │  提取适配器  │  PDF/OFD/XML/OCR → .extracted.json
                    └──────┬──────┘
                           ▼
                    ┌─────────────┐
                    │portable-core│  政策审核、整理、去重
                    └──────┬──────┘
                           ▼
                    ┌─────────────┐
                    │bundle.mjs   │  正式 Excel 生成（官方模板保真）
                    └──────┬──────┘
                           ▼
                    ┌─────────────┐
                    │  outputDir/ │  审核包 + 正式 Excel
                    └─────────────┘
```

## 快速开始

> 推荐用引导式配置脚本 `setup.mjs` 生成配置，而不是手写 `sources.json`。

### 1. 生成配置（引导式）

```bash
# 交互式（会依次询问数据源、路径、员工信息、邮箱设置）
node scripts/local-collector/setup.mjs

# 非交互（Agent 用，一次性传参；加 --print 先预览不落盘）
node scripts/local-collector/setup.mjs --mode local \
  --name 张三 --employee-id K12345 --department IT --level staff \
  --inbox ./inbox --output ./output

# 查看当前配置（敏感字段脱敏）
node scripts/local-collector/setup.mjs --show
```

`setup.mjs` 会写入 `sources.json` 与 `employee.json`（员工信息复用，下次无需重填）。手写 `sources.json` 仍然支持，格式如下：

```json
{
  "version": "1.0.0",
  "mode": "local",
  "inboxDir": "./inbox",
  "outputDir": "./output",
  "statePath": "./state.json",
  "employeeFile": "./employee.json",
  "excel": true
}
```

### 2. 把发票文件放入 inbox

支持的格式：
- `.pdf` — 电子发票 PDF（自动提取文本）
- `.ofd` — OFD 格式发票（解压读 XML）
- `.xml` — 全电 XML 发票
- `.png/.jpg/.jpeg` — 扫描件/照片（OCR）
- `.json` — 已提取的发票 JSON（直接采纳）
- `.txt` — 纯文本发票信息（直接采纳）

### 3. 执行

```bash
# 单次执行
node scripts/local-collector/index.mjs --config ./sources.json

# 轮询模式（每 5 分钟）
node scripts/local-collector/index.mjs --config ./sources.json --watch 300
```

## 邮箱模式

### 配置（推荐用 setup.mjs）

```bash
node scripts/local-collector/setup.mjs --mode mailbox --provider qq \
  --name 张三 --employee-id K12345 --level staff \
  --mailbox-user zhangsan@qq.com --mailbox-folder INBOX --since-days 30 \
  --password-env REBU_IMAP_PASS
```

`--provider`（qq/163/126/gmail/outlook/yeah）会自动填充 host/port/secure；自定义邮箱用 `--mailbox-host`/`--mailbox-port`。生成的配置形如：

```json
{
  "version": "1.0.0",
  "mode": "both",
  "inboxDir": "./inbox",
  "outputDir": "./output",
  "statePath": "./state.json",
  "employeeFile": "./employee.json",
  "mailbox": {
    "provider": "qq",
    "host": "imap.qq.com",
    "port": 993,
    "secure": true,
    "user": "user@example.com",
    "passwordEnv": "REBU_IMAP_PASS",
    "folder": "INBOX",
    "sinceDays": 30
  },
  "excel": true
}
```

### 设置密码环境变量

```bash
export REBU_IMAP_PASS="your-app-password-here"
```

**⚠️ 永远不要把密码写入 sources.json 或代码中。**

### 网络预检（公司网络必看）

在公司网络里连接外部邮箱经常失败——例如走 Palo Alto Prisma Access / SASE 的环境，出站 IMAP 端口（993/143）常被网关拦截。**mailbox 模式在拉取前会自动做一次带超时的连通性预检**，你也可以单独运行：

```bash
node scripts/local-collector/index.mjs --config ./sources.json --precheck
```

预检分两阶段（TCP 可达 → IMAP 连接/list），失败会给出可读提示：

- **端口不可达 / 超时**：可能是公司网络或代理拦截了出站邮箱端口，请切换到不受限网络（如手机热点）或按公司代理配置后重试。
- **认证失败**：邮箱账号或 IMAP 授权码不正确（不少邮箱需用“授权码”而非登录密码）。
- **域名解析失败**：检查 `mailbox.host`。

`mode=both` 时，预检失败会自动降级为只处理本地 inbox。

## 定时调度

### cron (Linux/macOS)

```bash
# 每天早上 8:00 执行
0 8 * * * cd /path/to/workdir && REBU_IMAP_PASS=xxx node /path/to/rebu/scripts/local-collector/index.mjs --config ./sources.json >> ./collector.log 2>&1

# 每 12 小时
0 */12 * * * cd /path/to/workdir && node /path/to/rebu/scripts/local-collector/index.mjs --config ./sources.json >> ./collector.log 2>&1
```

### launchd (macOS)

创建 `~/Library/LaunchAgents/com.rebu.local-collector.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.rebu.local-collector</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/path/to/rebu/scripts/local-collector/index.mjs</string>
        <string>--config</string>
        <string>/path/to/workdir/sources.json</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/workdir</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>REBU_IMAP_PASS</key>
        <string>从钥匙串获取或安全注入</string>
    </dict>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>8</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>/path/to/workdir/collector.log</string>
    <key>StandardErrorPath</key>
    <string>/path/to/workdir/collector-error.log</string>
</dict>
</plist>
```

加载:
```bash
launchctl load ~/Library/LaunchAgents/com.rebu.local-collector.plist
```

## 增量去重

三级去重保证发票不重复处理：

1. **邮件级**：`uidValidity:uid:filename`（mailbox 填充器写入 state）
2. **文件级**：SHA-256 hash（提取适配器标记）
3. **业务级**：`invoiceNumber|amount|invoiceDate`（portable-core `--state` 处理）

state.json 自动维护，无需手动管理。

## 输出结构

```
outputDir/
├── summary.md                      # 审核摘要
├── reimbursement-draft.json        # 报销草稿
├── policy-report.json              # 政策报告
├── review-questions.json           # 待决项（如有）
├── review-decisions.template.json  # 决定模板
├── template-input.json             # 供 template-adapter 消费
├── .assembled-input.json           # 组装的输入（内部）
└── bundle/                         # 正式 Excel（无待决项时）
    ├── *.xlsx                      # 正式费用报销单
    ├── bundle-summary.md
    └── bundle-manifest.json
```

## 约束

- 不新增 npm 依赖（只用仓库已有的 imapflow/pdf-parse/adm-zip/tesseract.js）
- 不修改 src/server 或 src/web
- 不内置守护进程（用 --watch 或 OS cron 定时）
- 凭据只通过环境变量，不写入配置或代码
- 正式 Excel 必须经过 template-adapter 的官方模板保真验证
