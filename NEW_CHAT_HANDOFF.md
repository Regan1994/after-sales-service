# 售服系統目前交接摘要

更新日期：2026-10-21（Asia/Taipei）

## 給新對話的第一句話

請先完整閱讀本文件、`SHARED_SERVER_PLAN.md`、`HANDOFF.md` 與 `WINDOWS_DEPLOYMENT.md`，再檢查 Git 狀態。聯網完整基準是已推送的 `codex/shared-server`（`e721ddf`），不可直接修改；目前功能開發分支是 `codex/service-desk-enhancements`，後續細節與新功能只在此分支進行。

## 目前實際狀態

- 原本單機 `localStorage` 原型已改成 Node.js + SQLite 內網服務。
- 管理者登入、訪客唯讀、伺服器端寫入權限、案件與主檔管理、列印、JSON 備份／還原已完成。
- 使用者已確認：管理者帳號／密碼正常；訪客不能修改，只能查看、搜尋、篩選與列印。
- 原本電腦曾成功讓其他電腦連線。
- 系統已搬到另一台伺服器電腦，該電腦已安裝 Node.js `22.23.3`。
- 新伺服器目前 IPv4：`192.168.0.187`。
- 新伺服器本機可啟動，但使用者回報其他電腦目前尚未連入；優先檢查是否以 `SERVICE_DESK_HOST=0.0.0.0` 啟動，以及 Windows 防火牆是否放行 TCP 8080。
- 預期網址：`http://192.168.0.187:8080`。
- 功能開發分支目前新增詢問紀錄、分類與族群管理、附件資料夾、保修卡／機台對應、測試案件清理器、獨立人員管理頁與管理分區權限控制；詳細內容請看 `HANDOFF.md`。

## 新視窗接手：目前開發進度（2026-10-21）

- 目前分支：`codex/service-desk-enhancements`；目前 `HEAD` 是 `e721ddf`，此 commit 同時是已推送且凍結的聯網基底 `codex/shared-server`。功能開發只在目前分支繼續，絕不可切到或修改 `codex/shared-server`。
- 所有新功能目前仍是未提交的工作樹變更，必須保留。接手第一步先執行 `git status --short --branch`、`git diff --stat`，不要 reset、清理、覆蓋或還原現有檔案。
- 最近新增的案件欄位：訂單號碼、出廠日期、改善單位；原介面欄位「售服人員」改稱「提案者」，後端仍沿用舊欄位以維持既有資料相容。新欄位已串接表單、列表、搜尋、詳細資料、列印及 JSON 備份／還原；舊 SQLite 資料庫會自動新增空欄位。
- 目前功能開發的未提交檔案：`.gitignore`、`HANDOFF.md`、`WINDOWS_DEPLOYMENT.md`、`dist/index.html`、`server.js`、`test/server.test.js`。本次交接文件會單獨提交，不把既有程式修改混入同一個 commit。
- 目前驗證已通過：`npm test`（2/2）、`npm run check`、前端內嵌 JavaScript 語法檢查、`git diff --check`。繼續修改後要重新執行至少 `npm test`、`npm run check` 和 `git diff --check`。
- 本次使用者另提出新需求：售服案件表格需新增／呈現「訂單號碼」「出廠日期」「改善單位」，並將「售服人員」改成「提案者」。此需求已在目前工作樹實作並記錄；若使用者要再調整細節，應在此分支延續。

## 舊版 Excel 匯入進度（2026-10-21）

- 來源檔案：`E:\改善清單(售服部)1005.xlsx`。
- 原始資料共 319 筆案件；最後一列是分類／人員說明，不算案件。
- 已建立分類報告：`outputs\import-classification\改善清單_匯入分類報告.xlsx`，包含「分類摘要」「可匯入」「待確認」三個工作表。
- 已依使用者確認先匯入 232 筆「可匯入」資料；87 筆「待人工確認」資料暫不匯入。
- 匯入結果：案件 232 筆、客戶 178 筆、機台 146 筆、問題類別 9 筆、提案者 7 筆、單一保修卡主檔 172 筆。
- 案件狀態對應：`YES` → `closed`（已結案）147 筆；`NO` → `processing`（處理中）84 筆；`TBC／待追蹤` → `pending`（待確認）1 筆。
- `TJS19F357-FS` 共 7 筆全部留在待確認清單，沒有匯入；其他重複保修卡號視為同一機台的多次報修。
- 21 筆可匯入資料含多個保修卡號，保留在同一案件的保修卡號文字中，沒有拆成多筆案件；多保修卡號不建立單一保修卡主檔。
- 舊 Excel 沒有提供聯絡人、電話、維護地址、維修日期、詢問記錄與零件資料，這些欄位匯入後留白。
- 舊欄位對應：日期 → 報修日期、客戶 → 客戶名稱、機型 → 機台型號、訂單號 → 訂單號碼、出廠日期 → 機台出廠日期、提案者 → 提案者、案發事件 → 故障描述、分類 → 問題類別、改善單位 → 改善單位；備註／改善方式／下一步合併保留在處理結果。
- 匯入前資料庫備份：`backups\service-desk-pre-legacy-import-2026-10-21T06-13-24-180Z.sqlite`。
- 匯入後已透過 `http://127.0.0.1:8080/api/state` 驗證系統可讀取 232 筆案件；必要欄位皆有值，`TJS19F357-FS` 為 0 筆。
- 下一步：人工確認 87 筆待確認資料；若之後需要更完整的多保修卡管理，再評估把目前保修卡文字欄位改成結構化多值欄位。

## 新伺服器啟動方式

在新伺服器 PowerShell 執行：

```powershell
cd 'C:\ServiceDesk'
$env:SERVICE_DESK_HOST = '0.0.0.0'
$env:SERVICE_DESK_PORT = '8080'
node .\server.js
```

也可以雙擊：

```text
C:\ServiceDesk\啟動售服系統.cmd
```

黑色視窗必須保持開啟。不要使用 `192.168.0.1` 綁定服務；那通常是路由器，不是伺服器本身的 IP。

## 新伺服器檔案配置

預期目錄：

```text
C:\ServiceDesk\server.js
C:\ServiceDesk\package.json
C:\ServiceDesk\啟動售服系統.cmd
C:\ServiceDesk\dist\index.html
C:\ServiceDesk\data\service-desk.sqlite
```

`data\service-desk.sqlite` 包含案件資料與管理者密碼雜湊，不要公開或放到公開雲端。若是使用 JSON 匯入而不是複製資料庫，第一次啟動前需要設定新的 `SERVICE_DESK_ADMIN_PASSWORD`；不要向使用者索取或回覆密碼。

## 防火牆檢查

在新伺服器以系統管理員身分開啟 PowerShell，依公司網路設定執行：

```powershell
New-NetFirewallRule `
  -DisplayName '售服系統內網 8080' `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalPort 8080 `
  -Profile Private,Domain `
  -RemoteAddress LocalSubnet
```

若伺服器網路類型是 `Public`，不要自行放寬成公開網路；請由公司 IT 確認網路設定。其他電腦測試：

```text
http://192.168.0.187:8080
```

## 重要檔案

- `server.js`：HTTP 服務、SQLite schema、登入、API、備份與還原。
- `dist/index.html`：前端介面，透過 API 讀寫資料。
- `啟動售服系統.cmd`：雙擊啟動伺服器的 Windows 啟動檔。
- `WINDOWS_DEPLOYMENT.md`：正式部署、防火牆、工作排程器與備份說明。
- `SHARED_SERVER_PLAN.md`：原始需求、權限、資料模型與驗收標準。
- `test/server.test.js`：伺服器健康檢查、訪客拒絕寫入、管理者登入與案件讀取測試。

## 驗證指令

在專案根目錄：

```powershell
npm test
npm run check
git diff --check
```

目前測試為 2/2 通過。匯入後仍需保留 `codex/service-desk-enhancements` 上的功能開發工作樹變更；本次只提交交接文件，不要重置、覆蓋或刪除其他未提交檔案，也不要直接修改 `codex/shared-server` 或自行合併回 `main`。

## 後續建議順序

1. 人工確認 87 筆待確認 Excel 資料。
2. 在新伺服器確認用 `0.0.0.0` 啟動。
3. 放行 Windows 防火牆 TCP 8080。
4. 從另一台電腦測試 `http://192.168.0.187:8080`。
5. 確認成功後設定 Windows 工作排程器開機自動啟動。
6. 伺服器 IP 固定或請 IT 配置 DHCP 保留，避免網址改變。
7. 最後再評估是否需要真正單一 `.exe`；目前 `.cmd` 已可雙擊啟動，其他電腦只需瀏覽器，不應各自啟動資料庫。
