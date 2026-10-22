# 售服系統內網共用版：Windows 部署與維護

本系統由一台 Windows 伺服器執行 Node.js 服務，瀏覽器只透過 HTTP 存取服務；不要讓其他電腦直接開啟或共同寫入 SQLite 檔案。

案件圖片與影片附件會由伺服器存放在專案下的 `attachments` 目錄，使用者不需要直接共用或修改這個目錄。附件只允許圖片與影片，單檔上限目前為 200 MB；JSON 資料備份與每日 SQLite 備份都不包含附件檔案。

保修卡與機台對應會包含在 JSON 資料備份中。測試資料清理器只會刪除案件表單明確標記為測試的案件及其附件；清理前需輸入確認文字並再次確認，未標記案件不受影響。

## 首次安裝

1. 在伺服器安裝 Node.js 24 LTS 或更新版本。
2. 將專案放到固定目錄，例如 `C:\ServiceDesk`。
3. 在 PowerShell 設定首次管理者密碼（至少 8 個字元）：

   ```powershell
   [Environment]::SetEnvironmentVariable('SERVICE_DESK_ADMIN_PASSWORD', '請改成正式密碼', 'Machine')
   ```

   密碼只會在第一次啟動時轉成雜湊值寫入 `data\service-desk.sqlite`；不會寫入原始碼、HTML、Git 或 JSON 備份。完成首次啟動後，可移除這個 Machine 環境變數。

   首次以管理者登入後，到「人員管理」建立業務、售服名單，並設定兩組共用密碼。業務與售服不使用個人帳號；問答紀錄中的提問者、回覆者需手動選取。業務登入後與管理者具有相同的管理權限；售服維持案件處理權限，但不能維護主檔或執行資料管理操作。若暫時無法使用管理者畫面，也可以在兩組密碼尚未建立時，分別以 `SERVICE_DESK_SALES_PASSWORD` 與 `SERVICE_DESK_SERVICE_PASSWORD` 環境變數設定初始密碼（同樣至少 8 個字元）。

4. 設定服務要使用的內網介面與連接埠。若伺服器有固定內網 IP，建議指定該 IP，不要綁定所有介面：

   ```powershell
   [Environment]::SetEnvironmentVariable('SERVICE_DESK_HOST', '192.168.1.20', 'Machine')
   [Environment]::SetEnvironmentVariable('SERVICE_DESK_PORT', '8080', 'Machine')
   ```

5. 在專案目錄啟動並確認：

   ```powershell
   npm start
   Invoke-RestMethod http://192.168.1.20:8080/api/health
   ```

   健康檢查應回傳 `ok: true`。使用者網址例如 `http://192.168.1.20:8080`。

也可以直接雙擊專案內的 `啟動售服系統.cmd`。它會使用檔案所在目錄啟動伺服器，並在伺服器電腦開啟瀏覽器；黑色視窗必須保持開啟。其他電腦仍使用伺服器的 IPv4 位址連線。

## Windows 防火牆

只允許公司內網網段存取 8080；以下範例的 `192.168.1.0/24` 請依公司網路調整：

```powershell
New-NetFirewallRule -DisplayName '售服系統內網 8080' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8080 -RemoteAddress 192.168.1.0/24
```

不要把連接埠轉發到網際網路，也不要把 `data`、`backups` 或 `attachments` 目錄設為 Windows 共用資料夾供使用者直接存取。

## 開機自動啟動

可用工作排程器建立「開機時執行」工作，執行檔為 `C:\Program Files\nodejs\node.exe`，引數為 `C:\ServiceDesk\server.js`，工作目錄為 `C:\ServiceDesk`。以服務帳號執行，並讓該帳號只需要讀寫專案的 `data`、`backups` 與 `attachments` 目錄。

案件詳細資料中的「開啟資料夾」會在伺服器電腦呼叫 Windows Explorer。若工作排程器使用沒有互動桌面的服務帳號，資料夾可能不會顯示；檔案上傳、下載與儲存仍可正常運作。

更新程式前先停止工作，保留 `data`、`backups` 和 `attachments`；更新後重新啟動並檢查 `/api/health`。不要刪除 SQLite 檔案來「重置」資料，若要清空資料請先由管理者下載備份並另行確認。

## 備份與還原

- 伺服器依其本機時區，每天晚上 22:00 建立一次 SQLite 快照於 `backups`；程式每分鐘檢查一次。若伺服器停機錯過時間，重啟後會補做一次，不會逐日補多份。最多保留最近 30 份 SQLite 快照。必須讓伺服器在排定時間持續執行，或在停機後重新啟動，備份才會發生。
- 管理者登入後使用「資料備份」下載 JSON；伺服器同時在 `backups` 建立 SQLite 快照。
- `POST /api/restore` 會在覆蓋前自動建立 SQLite 快照，並以交易方式還原；驗證或寫入失敗會回復資料庫。
- `backups` 位於同一台伺服器，無法防止整台設備或磁碟故障；如需異地保護，另由公司既有備份程序複製到不同磁碟。
- 還原前先確認備份檔格式為 `service-desk-backup`、版本 `1`，並使用管理者介面匯入。

## 維護檢查

```powershell
npm run check
Invoke-RestMethod http://127.0.0.1:8080/api/health
Get-ChildItem .\data, .\backups, .\attachments
```

訪客可以查看、搜尋、篩選、開啟詳細資料與列印。案件狀態只保留「新建、處理中、已結案、作廢」；等待客戶、等待零件、待確認、退回等舊狀態會歸入「處理中」。案件另以「目前處理方」標示業務或售服，取代轉交／退回／送確認按鈕。業務與售服登入後都能看到全部案件，兩組角色都能填寫與修改案件內容、回覆或編輯溝通紀錄、更新狀態與目前處理方、填寫結案責任，以及管理案件附件。一般案件儲存不會暗中新增或修改客戶、機型主檔。業務與管理者可調整客戶、機型、問題類別、零件清單、人員名單等主檔，也可刪除案件、備份與還原；售服不能執行這些管理操作。三種 Excel 可匯出所選案件或全部案件。權限由伺服器端執行，不僅是畫面隱藏按鈕。
