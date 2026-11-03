# AIPager

讓多台機器上的 Claude Code 透過一個中控 Hub 互相派工、回報、對話，不需要人轉貼 prompt。

- **Hub**：Ubuntu 24.04 / 26.04（systemd），只綁 Tailscale IP，不執行任何程式
- **節點**：Windows、macOS、Linux，用一次性加入碼動態加入，需人工核准；名稱、角色、標籤、機器類型在 Hub 上隨時調整
- **在線判斷**：依心跳判斷 online / asleep / offline；派給睡著的機器時提醒發派者與使用者；Dashboard 首頁列出誰睡著、哪些任務卡住
- **派工**：互動 session 的 Claude 透過 MCP 用自然語言派工；Worker 以 `claude -p` 執行，權限由本機 profile 決定；超出權限的動作送到 Dashboard 由人核准

目前狀態：**v0.5，P0 功能已實作並通過自動化測試；尚未在多台實機（Windows、macOS、經 Tailscale）驗證。** 驗證進度見 [`spec/tests/test-plan.json`](spec/tests/test-plan.json)。

完整設計：用瀏覽器開啟 [`docs/aipager-design.html`](docs/aipager-design.html)。
上線計畫（各階段怎麼裝、怎麼驗收、怎麼回報、待辦與待決定事項）：[`docs/aipager-rollout.html`](docs/aipager-rollout.html)。
在各台機器上讓 Claude 協助安裝時，它會讀 repo 根目錄的 [`CLAUDE.md`](CLAUDE.md)，並依上線計畫的「各機器工作清單」只做該機器角色的步驟。

## 安裝

需要 Node.js 22.13 以上（使用內建 `node:sqlite`，不需編譯原生模組）。所有機器都要裝 Tailscale 並加入同一個 tailnet。發行檔就是這個 repo：

```bash
git clone https://github.com/Hercules-Chen/aipager.git /opt/aipager
```

```bash
cd /opt/aipager && npm ci --omit=dev
```

### Hub（Ubuntu）

```bash
sudo /opt/aipager/spec/scripts/linux/install-hub.sh --allow-cidr 100.64.0.0/10
```

編輯 `/etc/aipager/hub.json` 的 `listen.host` 為 Hub 的 Tailscale IP，然後：

```bash
sudo -u aipager /opt/node-v22/bin/node /opt/aipager/bin/aipagerctl.js admin init --config /etc/aipager/hub.json
```

```bash
sudo systemctl enable --now aipager-hub
```

在你自己的電腦保存 admin token（之後的管理指令與 Dashboard 都用它）：

```bash
node bin/aipagerctl.js admin save-token <apa_...> --hub http://aipager-hub:7300
```

Dashboard：`http://aipager-hub:7300/ui/`

### 加入一台機器（Windows / macOS / Linux 相同）

1. 先在該機器安裝 Git、Claude Code（以要跑 Worker 的帳號登入一次）、Node 22、本 repo。
2. 管理者建立加入碼（或在 Dashboard「新增機器」）：

```bash
node bin/aipagerctl.js enroll create --name "Build PC" --power desktop --role builder
```

3. 在新機器加入並安裝服務：

```bash
node bin/aipagerctl.js join --hub http://aipager-hub:7300 --code ape_XXXX-XXXX-XXXX-XXXX
```

```bash
node bin/aipagerctl.js service install
```

4. 管理者在 Dashboard 按「核准」，或：

```bash
node bin/aipagerctl.js nodes approve build-pc
```

5. 檢查：

```bash
node bin/aipagerctl.js doctor
```

只當互動機（不接任務）時，join 加 `--no-worker`。Mac 若要重開機後免登入執行，見設計文件「部署」章節的 LaunchDaemon 與 `claude setup-token`。

### 互動 session 使用 MCP

```bash
claude mcp add --scope user --env AIPAGER_AGENT=main aipager -- node /opt/aipager/bin/aipager-mcp.js --mode interactive
```

Windows 把路徑換成 `C:\Program Files\AIPager\bin\aipager-mcp.js`。未讀提示 hook 的設定見 `spec/claude/settings.hooks.*.json`。之後直接對 Claude 說「叫 build-pc 用 build profile 編譯目前的 commit」。

## 開發與測試

```bash
npm ci
```

```bash
npm test
```

`npm test` 依序執行：規格驗證、文件建置與編碼稽核、Hub 整合測試、端對端測試（stub claude 會實際呼叫 MCP）、操作流程測試（真實程序）、Dashboard 瀏覽器測試（需要 Playwright，沒有時自動略過），以及 POSIX 腳本測試。

用真實 Claude Code 測試（會產生少量費用，約 0.01 USD）：

```bash
npm run test:real-claude
```

Hub 安裝腳本實跑測試會修改系統，只能在用完即丟的 Ubuntu 機器或容器中執行：

```bash
sudo AIPAGER_TEST_ALLOW_SYSTEM_CHANGES=1 bash tools/tests/linux-install-hub.test.sh
```

## 除錯

- 每個元件都寫 JSONL Log（UTF-8 無 BOM），每筆帶 `trace_id`：Hub 在 `/var/log/aipager/`；節點在 Windows `C:\ProgramData\AIPager\logs`、macOS `~/Library/Logs/AIPager`、Linux `~/.local/state/aipager/logs`
- 每個任務在 Worker 的任務目錄保留 `cmdline.txt`（可手動重跑）、`prompt.txt`、`stream.jsonl`、`stderr.log`、`result.json`
- Chrome DevTools：`node --inspect=127.0.0.1:9229 bin/hub.js ...`；Worker 用 `AIPAGER_INSPECT_PORT=9230`；Dashboard 未打包，F12 直接下中斷點；網址加 `?debug=1` 顯示原始 JSON
- `aipagerctl tasks --stuck` 列出卡住的任務與原因；`aipagerctl tail` 即時顯示事件

## 目錄

| 路徑 | 內容 |
|---|---|
| `bin/` | `hub.js`、`worker.js`、`aipager-mcp.js`、`aipager-hint.js`、`aipagerctl.js` |
| `lib/` | `common/`、`hub/`、`worker/`、`mcp/`、`ctl/` |
| `ui/` | Dashboard |
| `spec/` | JSON Schema、參考實作、SQL、MCP 工具定義、prompt、設定範本、各 OS 服務腳本、測試清單（執行時直接讀取，與規格同一份） |
| `docs/` | 文件原始檔（`docs/src/design/`、`docs/src/rollout/`，共用 `docs/src/layout.html`）與產出的 HTML |
| `tests/`、`tools/` | 測試與驗證、文件建置工具 |

## 修改規則

- 改文件請改 `docs/src/design/` 或 `docs/src/rollout/` 下的原始檔，再執行 `npm run check`，不要直接改產出的 HTML
- 測試結果記錄在 `spec/tests/test-plan.json`，文件的驗證計畫由它產生
- 編碼：一律 UTF-8 無 BOM、LF；例外是 `.bat`（純 ASCII、CRLF）與 `.ps1`（UTF-8 BOM、CRLF），由 `.gitattributes` 與建置稽核把關
