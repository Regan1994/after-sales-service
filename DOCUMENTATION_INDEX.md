# 售服系統文件索引

更新日期：2026-10-22（Asia/Taipei）

## 目前狀態

- 目前分支：`codex/service-account-refinement`
- 本輪基底提交：`ea72159`（業務帳號階段完成）
- 售服帳號權限、案件表單易用性與責任歸屬操作修正已完成；最新提交請以 `git log -1` 為準
- 主分支：不修改、不合併

## 接手時的閱讀順序

1. `USABILITY_REFINEMENT_HANDOFF.md`：目前唯一的功能、流程、角色權限與測試交接來源。
2. `WINDOWS_DEPLOYMENT.md`：Windows 啟動、內網、防火牆、備份、還原與維護。
3. `POST_DEMO_REQUIREMENTS_HANDOFF.md`：展示後需求背景；若與目前文件衝突，以目前文件為準。
4. `NEW_CHAT_HANDOFF.md`：2026-10-21 伺服器搬移與舊 Excel 匯入紀錄，屬歷史資料。
5. `HANDOFF.md`：共用版早期改造背景，屬歷史資料。
6. `SHARED_SERVER_PLAN.md`：最初規格與驗收標準，屬歷史資料。

## 目前驗證

在專案根目錄執行：

```powershell
npm test
npm run check
node -e "const s=require('fs').readFileSync('dist/index.html','utf8');const a=s.indexOf('<script>')+8;const b=s.lastIndexOf('</script>');new Function(s.slice(a,b));console.log('inline JS syntax OK')"
git diff --check
```
