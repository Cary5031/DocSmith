package main

import (
	"net/http"
	"os"
	"path/filepath"
)

// docMiddleware 讓預覽能顯示本機圖片：前端把 <img src="images/a.png"> 改寫成
// /__doc?p=images%2Fa.png，這裡以目前文件所在資料夾為基準讀檔回傳；
// 其他請求交給內嵌的網頁資源。
type docMiddleware struct {
	app  *App
	next http.Handler
}

func (h *docMiddleware) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/__doc" {
		h.next.ServeHTTP(w, r)
		return
	}
	p := r.URL.Query().Get("p")
	if p == "" {
		http.NotFound(w, r)
		return
	}
	if !filepath.IsAbs(p) {
		dir := h.app.docDir()
		if dir == "" {
			http.NotFound(w, r)
			return
		}
		p = filepath.Join(dir, filepath.FromSlash(p))
	}

	f, err := os.Open(p)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, info.Name(), info.ModTime(), f)
}
