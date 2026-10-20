# 售服系統目前交接摘要

更新日期：2026-10-20（Asia/Taipei）

## 給新對話的第一句話

請先完整閱讀本文件、`SHARED_SERVER_PLAN.md`、`HANDOFF.md` 與 `WINDOWS_DEPLOYMENT.md`，再檢查 Git 狀態。現在的工作分支是 `codex/shared-server`，不要修改或合併 `main`。使用者已完成內網實際測試，下一步是確認新伺服器的防火牆與固定啟動方式。

## 目前實際狀態

- 原本單機 `localStorage` 原型已改成 Node.js + SQLite 內網服務。
- 管理者登入、訪客唯讀、伺服器端寫入權限、案件與主檔管理、列印、JSON 備份／還原已完成。
- 使用者已確認：管理者帳號／密碼正常；訪客不能修改，只能查看、搜尋、篩選與列印。
- 原本電腦曾成功讓其他電腦連線。
- 系統已搬到另一台伺服器電腦，該電腦已安裝 Node.js `22.23.3`。
- 新伺服器目前 IPv4：`192.168.0.187`。
- 新伺服器本機可啟動，但使用者回報其他電腦目前尚未連入；優先檢查是否以 `SERVICE_DESK_HOST=0.0.0.0` 啟動，以及 Windows 防火牆是否放行 TCP 8080。
- 預期網址：`http://192.168.0.187:8080`。

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

目前測試為 2/2 通過。Git 工作樹含本次實作的未提交變更；先前嘗試 commit 時因 `.git` 唯讀、無法建立 `.git\index.lock` 而失敗。不要重置、覆蓋或刪除現有變更，也不要自行合併回 `main`。

## 後續建議順序

1. 在新伺服器確認用 `0.0.0.0` 啟動。
2. 放行 Windows 防火牆 TCP 8080。
3. 從另一台電腦測試 `http://192.168.0.187:8080`。
4. 確認成功後設定 Windows 工作排程器開機自動啟動。
5. 伺服器 IP 固定或請 IT 配置 DHCP 保留，避免網址改變。
6. 最後再評估是否需要真正單一 `.exe`；目前 `.cmd` 已可雙擊啟動，其他電腦只需瀏覽器，不應各自啟動資料庫。
