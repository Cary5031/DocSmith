package main

import (
	"bytes"
	"errors"
	"os"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/encoding/traditionalchinese"
	"golang.org/x/text/encoding/unicode"
)

var (
	utf8BOM    = []byte{0xEF, 0xBB, 0xBF}
	utf16LEBOM = []byte{0xFF, 0xFE}
	utf16BEBOM = []byte{0xFE, 0xFF}

	// 前端依這個訊息判斷「不是文字檔」
	errBinaryFile = errors.New("BINARY_FILE")
)

// Document 是開啟檔案後回傳給前端的內容。
// Content 一律以 "\n" 換行；原檔的編碼、換行格式與 BOM 記在欄位中，存檔時還原。
type Document struct {
	Path     string `json:"path"`
	Content  string `json:"content"`
	Encoding string `json:"encoding"` // UTF-8、UTF-16LE、UTF-16BE、Big5
	CRLF     bool   `json:"crlf"`
	BOM      bool   `json:"bom"`
}

// looksBinary：前 8KB 內有 NUL 字元就視為二進位檔（UTF-16 已先排除）。
func looksBinary(b []byte) bool {
	if len(b) > 8192 {
		b = b[:8192]
	}
	return bytes.IndexByte(b, 0) >= 0
}

// decodeText 把檔案內容解碼成字串：支援 UTF-8（含 BOM）、UTF-16（有 BOM）、Big5；二進位檔回傳 errBinaryFile。
func decodeText(b []byte) (*Document, error) {
	doc := &Document{Encoding: "UTF-8"}
	switch {
	case bytes.HasPrefix(b, utf8BOM):
		doc.BOM = true
		b = b[len(utf8BOM):]
	case bytes.HasPrefix(b, utf16LEBOM), bytes.HasPrefix(b, utf16BEBOM):
		doc.BOM = true
		doc.Encoding = "UTF-16LE"
		endian := unicode.LittleEndian
		if bytes.HasPrefix(b, utf16BEBOM) {
			doc.Encoding = "UTF-16BE"
			endian = unicode.BigEndian
		}
		decoded, err := unicode.UTF16(endian, unicode.ExpectBOM).NewDecoder().Bytes(b)
		if err != nil {
			return nil, err
		}
		b = decoded
	}
	if doc.Encoding == "UTF-8" {
		if looksBinary(b) {
			return nil, errBinaryFile
		}
		if !utf8.Valid(b) {
			if decoded, err := traditionalchinese.Big5.NewDecoder().Bytes(b); err == nil {
				b = decoded
				doc.Encoding = "Big5"
			}
		}
	}
	s := string(b)
	doc.CRLF = strings.Contains(s, "\r\n")
	doc.Content = strings.ReplaceAll(s, "\r\n", "\n")
	return doc, nil
}

// ReadFile 讀取文字檔（編碼判斷見 decodeText）。
func (a *App) ReadFile(path string) (*Document, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	doc, err := decodeText(b)
	if err != nil {
		return nil, err
	}
	doc.Path = path
	return doc, nil
}

// SaveFile 寫檔並保留原本的換行格式與 BOM；UTF-16 檔案存回 UTF-16，其他一律 UTF-8。
func (a *App) SaveFile(path, content string, crlf, bom bool, encoding string) error {
	if crlf {
		content = strings.ReplaceAll(content, "\n", "\r\n")
	}
	var out []byte
	switch encoding {
	case "UTF-16LE", "UTF-16BE":
		endian := unicode.LittleEndian
		if encoding == "UTF-16BE" {
			endian = unicode.BigEndian
		}
		encoded, err := unicode.UTF16(endian, unicode.UseBOM).NewEncoder().Bytes([]byte(content))
		if err != nil {
			return err
		}
		out = encoded
	default:
		var buf bytes.Buffer
		if bom {
			buf.Write(utf8BOM)
		}
		buf.WriteString(content)
		out = buf.Bytes()
	}
	return os.WriteFile(path, out, 0o644)
}
