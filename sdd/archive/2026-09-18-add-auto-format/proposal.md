# add-auto-format（新功能）

## 為什麼做

文件與程式碼常有縮排不一、表格沒對齊、中英文擠在一起等問題，手動整理費時。希望一鍵依文件類型自動排版。

## 要改什麼

- 工具列「自動排版」按鈕（Shift+Alt+F），依文件類型選擇排版方式，全部內嵌、離線可用：
  | 類型 | 排版方式 |
  | --- | --- |
  | Markdown | Prettier（清單、表格對齊、空行）＋中英文之間加空格（不動程式碼、公式、網址） |
  | JSON | 展開為 2 格縮排（含註解的 JSON 用 Prettier） |
  | JavaScript / TypeScript / CSS / SCSS / LESS / HTML / Vue / YAML / GraphQL | Prettier |
  | SQL | sql-formatter |
  | XML / SVG / XAML / csproj 等 | xml-formatter |
  | Go | gofmt（Go 官方規則） |
  | Python | Ruff |
  | C# / Java / C / C++ | clang-format |
  | 純文字 | 去除行尾空白、多餘空行，中英文之間加空格 |
- 只替換有變動的範圍，可用 Ctrl+Z 復原；狀態列顯示使用的排版工具
- 不支援的類型、語法錯誤時顯示訊息，不修改內容
- PDF、電子書分頁停用此按鈕

## 影響範圍

- `frontend/src/format.js`（新增）、`gofmt.go`（新增）
- `frontend/src/main.js`、`frontend/src/i18n.js`、`frontend/src/style.css`
- `frontend/package.json`（prettier、sql-formatter、xml-formatter、@wasm-fmt/ruff_fmt、@wasm-fmt/clang-format）
