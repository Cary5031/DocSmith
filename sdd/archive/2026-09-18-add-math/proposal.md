# add-math（新功能）

## 為什麼做

技術文件、報告常需要數學公式；目前 `$E=mc^2$` 只會顯示原始文字。

## 要改什麼

- 預覽支援 LaTeX 數學公式（KaTeX 繪製，離線內嵌字型）：
  - 行內公式：`$E=mc^2$`
  - 區塊公式：`$$ ... $$`（可跨多行）
  - GitHub 相容寫法：```` ```math ```` 程式碼區塊
- 公式語法錯誤時以紅字顯示原始公式與錯誤，不影響其他內容
- 工具列新增「數學公式」按鈕，插入區塊公式範本
- 一般金額文字（例如「$100 與 $200」）不應被誤判為公式

## 影響範圍

- `frontend/package.json`（新增 katex、@vscode/markdown-it-katex）
- `frontend/src/preview.js`（掛上 KaTeX 外掛、```math 區塊）
- `frontend/src/editor.js`（插入公式指令）
- `frontend/src/main.js`（工具列按鈕）
- `frontend/src/i18n.js`、`frontend/src/style.css`
