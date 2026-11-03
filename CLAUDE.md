# AIPager 專案說明（給在這個 repo 工作的 Claude）

AIPager 讓多台機器上的 Claude Code 透過一個 Hub 互相派工與傳訊。只用繁體中文或英文回應。

## 0. 先判斷你是哪一種工作

| 情況 | 你該做的事 |
|---|---|
| 環境變數 `AIPAGER_TASK_ID` 有值 | 你是 AIPager Worker 執行中的任務。忽略本檔，只依任務的 system prompt 與 profile 行事 |
| 使用者要你在這台機器「上線 / 安裝 / 加入 AIPager」 | 依第 1 節的上線流程 |
| 使用者要你修改 AIPager 的程式或文件 | 依第 2 節的開發規則 |

## 1. 上線流程（各機器的 Claude）

1. **確認角色。**問使用者這台是哪個角色，並確認作業系統相符。沒有得到明確答案前不要執行任何安裝指令。

   | 代號 | 機器 | 作業系統 |
   |---|---|---|
   | H | Hub 機（Tailscale 名稱 aipager-hub） | Ubuntu 24.04 / 26.04 |
   | D | 使用者的電腦（node_id dev-pc，互動機，不跑 Worker） | 任一 |
   | B | build-pc（Worker） | Windows |
   | M | macbook-hc（Worker，筆電） | macOS |
   | L | linux-box（Worker） | Linux |

2. **讀文件。**先讀 `docs/src/rollout/sections/04-machines.html`（各機器工作清單：先後順序、停下來的點），再讀該角色負責的章節（同目錄的 `06-r1-hub.html` 到 `11-r6-hardening.html`）。指令與預期結果以這些原始檔為準；`docs/aipager-rollout.html` 是建置後的同一份內容。設計細節在 `docs/src/design/sections/`。
3. **確認前置條件。**依 04-machines 的「先後順序」問使用者前面的機器是否已完成；需要的加入碼或 admin token 由使用者提供。
4. **一步一步做。**每一步先說明是哪一章的哪一步，再執行，並把實際輸出和文件的「預期」比對。不要一次跑完整段。
5. **必須停下來交給使用者的情況**（詳見 04-machines 的表格）：
   - 需要 sudo、Windows 系統管理員權限或密碼
   - Tailscale 登入或改名、`claude` 帳號登入
   - Dashboard 核准機器或審核工具呼叫
   - 闔蓋、重開機等實體操作
   - 結果與「預期」不同：停止，依 `13-reporting.html` 整理回報，不要自行換做法繞過
   - 步驟屬於別的角色：不執行，告訴使用者應在哪台做
6. **回報。**每完成一個章節或一個測試項目（T 編號），依 `13-reporting.html` 的範本整理：階段、測試、機器、指令、完整輸出、預期與實際的差異、task_id。

### 上線時絕對不要做的事

- 不要把 token 或加入碼（`apa_`、`apn_`、`apt_`、`ape_` 開頭）寫進 repo 內的任何檔案、commit、PR 或 Log 摘要；只在終端機顯示一次並請使用者保存
- 不要修改其他機器的設定，不要替其他角色執行步驟
- 不要直接 push 到 main；不要使用 git worktree
- 不要為了讓步驟通過而修改 AIPager 程式。發現程式問題時描述現象與原因、提出修改建議，使用者同意後才改（依第 2 節）

## 2. 開發規則（修改程式或文件時）

- 分支：從 main 開新分支，例如 `claude/rollout-r2-windows`；一個上線階段一個 PR，PR 說明附該階段的測試結果。不使用 git worktree
- 測試：PR 前執行 `npm test`，必須全部通過（Linux）；改到 Worker 執行 claude 的部分時另跑 `npm run test:real-claude`（會實際呼叫 Claude，費用約 0.01 USD）
- 文件：改 `docs/src/design/` 或 `docs/src/rollout/` 的原始檔，再執行 `npm run check`（建置、錨點與交叉引用檢查、全文編碼稽核）；不要直接改 `docs/*.html`
- 測試結果：寫回 `spec/tests/test-plan.json` 對應項目的 `status` 與 `last_run`；文件中的測試狀態由它產生
- 編碼：一律 UTF-8 無 BOM、LF。例外：`.bat` 純 ASCII、CRLF；`.ps1` UTF-8 BOM、CRLF（由 `.gitattributes` 與 `npm run check` 把關）
- Windows 的 Log 與資料放在 `C:\ProgramData\AIPager`；不要放在程式目錄
- 不要修改討論範圍以外的程式或註解；決定不了的事情提出來問，不要自行決定
- 驗證要實際執行並看輸出，不要只憑推測下結論
