# 第三方套件（未透過 npm 安裝）

| 目錄 / 檔案 | 來源 | 授權 | 說明 |
| --- | --- | --- | --- |
| `xlsx-0.20.3.tgz` | https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz | Apache-2.0 | SheetJS 官方發佈版（npm 上的舊版有已知漏洞） |
| `foliate-js/` | https://github.com/johnfactotum/foliate-js（commit `78914aef4466eb960965702401634c2cb348e9b1`） | MIT | 電子書（EPUB / MOBI / AZW3 / FB2 / CBZ）解析與排版 |

## foliate-js 的修改

- 移除程式沒用到的檔案：範例閱讀器（reader.*、ui/）、OPDS、字典、測試、建置設定
- 移除 PDF 支援（`pdf.js`、`vendor/pdfjs/`）：PDF 由 DocSmith 自己的 PDF 閱讀器處理；`view.js` 的 `makeBook` 遇到 PDF 時改為丟出不支援的錯誤
