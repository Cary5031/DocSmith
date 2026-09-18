package main

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"
)

// 資料夾全文搜尋

type SearchOptions struct {
	Query         string `json:"query"`
	CaseSensitive bool   `json:"caseSensitive"`
	WholeWord     bool   `json:"wholeWord"`
	Regex         bool   `json:"regex"`
	MaxResults    int    `json:"maxResults"`
}

type SearchMatch struct {
	Line   int    `json:"line"`   // 1 起算
	Column int    `json:"column"` // 行內的字元位置（0 起算，以 Unicode 字元計）
	Length int    `json:"length"` // 符合文字的字元數
	Text   string `json:"text"`   // 該行內容（過長時截斷）
}

type SearchFileResult struct {
	Path    string        `json:"path"`
	Matches []SearchMatch `json:"matches"`
}

type SearchResult struct {
	Files     []SearchFileResult `json:"files"`
	Total     int                `json:"total"`
	Truncated bool               `json:"truncated"`
}

const (
	maxSearchFileSize = 5 << 20
	maxLineLength     = 240
)

// 不搜尋的二進位 / 非文字格式（PDF、電子書有各自閱讀器的搜尋）
var skipSearchExt = regexp.MustCompile(`(?i)\.(png|jpe?g|gif|bmp|webp|ico|pdf|epub|mobi|azw3?|cbz|fbz|zip|7z|rar|gz|exe|dll|so|docx|xlsx|xls|pptx|doc|ppt|mp3|mp4|mov|wav|woff2?|ttf|otf)$`)

// CompileSearch 依選項建立規則運算式；供前端檢查 regex 是否正確。
func compileSearch(opts SearchOptions) (*regexp.Regexp, error) {
	pattern := opts.Query
	if !opts.Regex {
		pattern = regexp.QuoteMeta(pattern)
	}
	if opts.WholeWord {
		pattern = `\b(?:` + pattern + `)\b`
	}
	if !opts.CaseSensitive {
		pattern = `(?i)` + pattern
	}
	return regexp.Compile(pattern)
}

// SearchFolder 搜尋資料夾內的文字檔；skip 為已由前端搜尋的檔案（開啟中的分頁）。
func (a *App) SearchFolder(root string, opts SearchOptions, skip []string) (*SearchResult, error) {
	result := &SearchResult{Files: []SearchFileResult{}}
	if opts.Query == "" || root == "" {
		return result, nil
	}
	re, err := compileSearch(opts)
	if err != nil {
		return nil, err
	}
	limit := opts.MaxResults
	if limit <= 0 {
		limit = 2000
	}
	skipSet := map[string]bool{}
	for _, p := range skip {
		skipSet[strings.ToLower(filepath.Clean(p))] = true
	}

	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if path != root && hiddenDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if result.Truncated || skipSet[strings.ToLower(filepath.Clean(path))] || skipSearchExt.MatchString(d.Name()) {
			return nil
		}
		info, err := d.Info()
		if err != nil || info.Size() > maxSearchFileSize || info.Size() == 0 {
			return nil
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		doc, err := decodeText(b)
		if err != nil {
			return nil
		}
		var matches []SearchMatch
		for i, line := range strings.Split(doc.Content, "\n") {
			for _, loc := range re.FindAllStringIndex(line, -1) {
				if loc[0] == loc[1] {
					continue // 空字串比對（例如 regex「a*」）不列出
				}
				if result.Total >= limit {
					result.Truncated = true
					break
				}
				matches = append(matches, SearchMatch{
					Line:   i + 1,
					Column: utf8.RuneCountInString(line[:loc[0]]),
					Length: utf8.RuneCountInString(line[loc[0]:loc[1]]),
					Text:   truncateLine(line),
				})
				result.Total++
			}
		}
		if len(matches) > 0 {
			result.Files = append(result.Files, SearchFileResult{Path: path, Matches: matches})
		}
		return nil
	})
	return result, nil
}

func truncateLine(line string) string {
	if utf8.RuneCountInString(line) <= maxLineLength {
		return line
	}
	return string([]rune(line)[:maxLineLength]) + "…"
}
