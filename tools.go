package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	xwin "golang.org/x/sys/windows"
)

// AI 可用的內建工具：列出、讀取、搜尋側邊欄開啟的資料夾，全部唯讀。
// 工具說明與回傳內容是給模型看的，所以用英文；錯誤也以文字回傳，讓模型自己決定下一步。

const (
	maxToolEntries = 200   // list_dir 最多列出幾項
	maxToolChars   = 20000 // read_file 最多回傳幾個字
	maxToolMatches = 100   // search_folder 最多回傳幾行
)

var errOutsideFolder = errors.New("the path is outside the open folder; only files inside it can be accessed")

type toolSpec struct {
	Type     string       `json:"type"`
	Function toolFunction `json:"function"`
}

type toolFunction struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters"`
}

func toolSchema(name, description, param, paramDescription string) toolSpec {
	return toolSpec{Type: "function", Function: toolFunction{
		Name:        name,
		Description: description,
		Parameters: map[string]any{
			"type":       "object",
			"properties": map[string]any{param: map[string]any{"type": "string", "description": paramDescription}},
			"required":   []string{param},
		},
	}}
}

// builtinTools 是請求裡的 tools 參數。
var builtinTools = []toolSpec{
	toolSchema("list_dir", "List the files and subfolders of a folder inside the folder the user has open. Subfolders end with '/'.",
		"path", `Folder path relative to the open folder; use "." for the open folder itself.`),
	toolSchema("read_file", "Read a text file inside the folder the user has open. Long files are truncated.",
		"path", "File path relative to the open folder."),
	toolSchema("search_folder", "Search the text files inside the folder the user has open (case-insensitive). Returns matching lines as path:line: text.",
		"query", "The text to search for."),
}

type toolArgs struct {
	Path  string `json:"path"`
	Query string `json:"query"`
}

func parseToolArgs(raw string) (toolArgs, error) {
	var args toolArgs
	if strings.TrimSpace(raw) == "" {
		return args, nil
	}
	err := json.Unmarshal([]byte(raw), &args)
	return args, err
}

// toolDetail 是面板上顯示的簡短說明：路徑或搜尋文字。
func toolDetail(name, raw string) string {
	args, _ := parseToolArgs(raw)
	detail := strings.TrimSpace(args.Path)
	if name == "search_folder" {
		detail = strings.TrimSpace(args.Query)
	} else if detail == "" && name == "list_dir" {
		detail = "."
	}
	if utf8.RuneCountInString(detail) > 80 {
		detail = string([]rune(detail)[:80]) + "…"
	}
	return detail
}

// runTool 執行一個工具呼叫，回傳要回填給模型的文字。
func (a *App) runTool(root, name, raw string) string {
	if root == "" {
		return "Error: no folder is open."
	}
	args, err := parseToolArgs(raw)
	if err != nil {
		return "Error: invalid arguments: " + err.Error()
	}
	var out string
	switch name {
	case "list_dir":
		out, err = a.toolListDir(root, args.Path)
	case "read_file":
		out, err = a.toolReadFile(root, args.Path)
	case "search_folder":
		out, err = a.toolSearch(root, args.Query)
	default:
		err = fmt.Errorf("unknown tool %q", name)
	}
	if err != nil {
		return "Error: " + err.Error()
	}
	return out
}

func (a *App) toolListDir(root, p string) (string, error) {
	dir, err := resolveToolPath(root, p)
	if err != nil {
		return "", err
	}
	rel := relDisplay(root, dir)
	info, err := os.Stat(dir)
	if err != nil {
		return "", fileError(rel, err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("%s is a file, not a folder; use read_file to read it", rel)
	}
	entries, err := a.ListDir(dir)
	if err != nil {
		return "", fileError(rel, err)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Contents of %s (%d items):\n", rel, len(entries))
	for i, e := range entries {
		if i == maxToolEntries {
			fmt.Fprintf(&b, "... and %d more\n", len(entries)-i)
			break
		}
		if e.IsDir {
			b.WriteString(e.Name + "/\n")
		} else {
			fmt.Fprintf(&b, "%s  (%s)\n", e.Name, formatSize(e.Size))
		}
	}
	return b.String(), nil
}

func (a *App) toolReadFile(root, p string) (string, error) {
	if strings.TrimSpace(p) == "" {
		return "", errors.New("the path is empty")
	}
	file, err := resolveToolPath(root, p)
	if err != nil {
		return "", err
	}
	rel := relDisplay(root, file)
	info, err := os.Stat(file)
	if err != nil {
		return "", fileError(rel, err)
	}
	if info.IsDir() {
		return "", fmt.Errorf("%s is a folder; use list_dir to see its contents", rel)
	}
	if info.Size() > maxSearchFileSize {
		return "", fmt.Errorf("%s is too large to read (%s)", rel, formatSize(info.Size()))
	}
	doc, err := a.ReadFile(file)
	if errors.Is(err, errBinaryFile) {
		return "", fmt.Errorf("%s is not a text file", rel)
	}
	if err != nil {
		return "", fileError(rel, err)
	}
	total := utf8.RuneCountInString(doc.Content)
	head := fmt.Sprintf("File %s (%d characters):\n", rel, total)
	if total > maxToolChars {
		return head + string([]rune(doc.Content)[:maxToolChars]) +
			fmt.Sprintf("\n[Truncated: showing the first %d of %d characters]", maxToolChars, total), nil
	}
	return head + doc.Content, nil
}

func (a *App) toolSearch(root, query string) (string, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return "", errors.New("the query is empty")
	}
	res, err := a.SearchFolder(root, SearchOptions{Query: query, MaxResults: maxToolMatches}, nil)
	if err != nil {
		return "", err
	}
	realRoot, err := realPath(root)
	if err != nil {
		return "", fileError(".", err)
	}
	var b strings.Builder
	lines, files := 0, 0
	for _, f := range res.Files {
		// SearchFolder 目前不會跟著 symlink、junction 走；這裡再確認一次實際位置，行為改變時也不會把資料夾外的內容交給模型
		if real, err := realPath(f.Path); err != nil || !insideFolder(realRoot, real) {
			continue
		}
		files++
		rel := relDisplay(root, f.Path)
		for _, m := range f.Matches {
			fmt.Fprintf(&b, "%s:%d: %s\n", rel, m.Line, strings.TrimSpace(m.Text))
			lines++
		}
	}
	if lines == 0 {
		return fmt.Sprintf("No matches for %q.", query), nil
	}
	head := fmt.Sprintf("%d matching lines in %d files for %q", lines, files, query)
	if res.Truncated {
		head += fmt.Sprintf(" (stopped at %d lines; use a more specific query to narrow it down)", maxToolMatches)
	}
	return head + ":\n" + b.String(), nil
}

// resolveToolPath 把模型給的路徑轉成資料夾內的絕對路徑。
// 「..」、其他磁碟、UNC 路徑，以及 symlink / junction 指到資料夾外的情況一律拒絕。
func resolveToolPath(root, p string) (string, error) {
	root = filepath.Clean(root)
	p = strings.TrimSpace(p)
	var target string
	switch {
	case filepath.IsAbs(p):
		target = filepath.Clean(p)
	case filepath.VolumeName(p) != "":
		return "", errOutsideFolder // 例如「C:foo」這種磁碟機相對路徑
	default:
		// 「/README.md」這種寫法視為從資料夾根目錄算起
		target = filepath.Join(root, strings.TrimLeft(p, `/\`))
	}
	if !insideFolder(root, target) {
		return "", errOutsideFolder
	}
	realRoot, err := realPath(root)
	if err != nil {
		return "", fileError(".", err)
	}
	real, err := realPath(target)
	if err != nil {
		return "", fileError(relDisplay(root, target), err)
	}
	if !insideFolder(realRoot, real) {
		return "", errOutsideFolder
	}
	return target, nil
}

// insideFolder：target 是 root 本身或其中的項目（IsLocal 也會擋掉 CON、NUL 這類裝置名稱）。
func insideFolder(root, target string) bool {
	rel, err := filepath.Rel(root, target)
	return err == nil && (rel == "." || filepath.IsLocal(rel))
}

// realPath 回傳檔案實際所在的位置，會解開 symlink、junction 等所有連結。
// 不用 filepath.EvalSymlinks：Go 1.23 起它在 Windows 不再解開 junction（winsymlink=1）。
func realPath(path string) (string, error) {
	name, err := xwin.UTF16PtrFromString(path)
	if err != nil {
		return "", err
	}
	h, err := xwin.CreateFile(name, 0, xwin.FILE_SHARE_READ|xwin.FILE_SHARE_WRITE|xwin.FILE_SHARE_DELETE,
		nil, xwin.OPEN_EXISTING, xwin.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return "", &os.PathError{Op: "open", Path: path, Err: err}
	}
	defer xwin.CloseHandle(h)
	buf := make([]uint16, xwin.MAX_PATH)
	for {
		n, err := xwin.GetFinalPathNameByHandle(h, &buf[0], uint32(len(buf)), 0)
		if err != nil {
			return "", err
		}
		if int(n) < len(buf) {
			s := xwin.UTF16ToString(buf[:n])
			if rest, ok := strings.CutPrefix(s, `\\?\UNC\`); ok {
				return `\\` + rest, nil
			}
			return strings.TrimPrefix(s, `\\?\`), nil
		}
		buf = make([]uint16, n) // 空間不夠時 n 是需要的長度
	}
}

// relDisplay 是給模型看的相對路徑（一律用 /）。
func relDisplay(root, target string) string {
	rel, err := filepath.Rel(root, target)
	if err != nil {
		return filepath.Base(target)
	}
	return filepath.ToSlash(rel)
}

// fileError 把檔案錯誤轉成簡短說明，不帶出完整的本機路徑。
func fileError(rel string, err error) error {
	switch {
	case errors.Is(err, os.ErrNotExist):
		return fmt.Errorf("%s was not found", rel)
	case errors.Is(err, os.ErrPermission):
		return fmt.Errorf("access to %s was denied", rel)
	}
	return fmt.Errorf("cannot open %s", rel)
}

func formatSize(n int64) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.1f KB", float64(n)/(1<<10))
	}
	return fmt.Sprintf("%d B", n)
}
