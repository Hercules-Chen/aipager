# Claude Relay（aipager）設計規格

讓多台機器上的 Claude Code 透過一個中控 Hub 互相派工、回報、對話，不需要人轉貼 prompt。

- Hub：Ubuntu 24.04 / 26.04（systemd），只綁 Tailscale IP
- 節點：Windows、macOS、Linux，以一次性加入碼動態加入，機器資料在 Hub 上隨時調整
- 在線判斷：依心跳判斷 online / asleep / offline；派給睡著的機器時提醒發派者與使用者

目前狀態：**設計規格 v0.3（草案），尚未實作。**

## 閱讀文件

用瀏覽器開啟 [`docs/claude-relay-design.html`](docs/claude-relay-design.html)，左側有章節目錄。

## 目錄

| 路徑 | 內容 |
|---|---|
| `docs/src/` | 文件原始檔（一章一個檔案），HTML 由程式產生 |
| `docs/claude-relay-design.html` | 產出的完整文件 |
| `spec/schemas/` | 封包與 API 的 JSON Schema（draft 2020-12） |
| `spec/examples/` | 封包與 API 範例（全部經過 schema 驗證） |
| `spec/reference/presence.js` | 在線判斷、租約保留、睡眠偵測、派工決策的參考實作 |
| `spec/sql/hub-schema.sql` | Hub 資料庫 DDL（SQLite） |
| `spec/mcp/relay-tools.json` | MCP 工具定義 |
| `spec/config/` | Hub 與各平台節點的設定範本 |
| `spec/scripts/` | Windows / macOS / Linux 的啟動與服務設定腳本 |
| `tools/validate-spec.js` | 驗證全部規格檔 |
| `tools/build-doc.js` | 產生 HTML 文件並稽核全專案編碼 |

## 驗證與重新產生文件

需要 Node.js 22.13 以上（`node:sqlite` 內建）。

```bash
npm ci
```

```bash
npm run check
```

`npm run check` 會先跑 `validate`（schema、範例、反例、參考實作、DDL、領任務 SQL），再跑 `build:doc`（產生 HTML、檢查錨點與交叉引用、編碼與換行稽核）。兩者都必須顯示 PASSED。

## 修改規則

- 改文件請改 `docs/src/` 下的原始檔，不要直接改產出的 HTML
- 章節編號、目錄、交叉引用由 `tools/build-doc.js` 自動產生；交叉引用寫 `<a data-ref="章節id"></a>`
- 編碼：一律 UTF-8 無 BOM、LF；例外是 `.bat`（純 ASCII、CRLF）與 `.ps1`（UTF-8 BOM、CRLF），由 `.gitattributes` 與 build 稽核把關
