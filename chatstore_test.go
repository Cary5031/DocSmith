package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 對話存放：加密主檔 + 明文備援 + 100 組上限 + .gitignore
func chatDoc(id, title string, updated int64, messages int) string {
	msgs := make([]map[string]string, messages)
	for i := range msgs {
		msgs[i] = map[string]string{"role": "user", "content": fmt.Sprintf("第 %d 則訊息，內容要長一點才看得出壓縮效果。", i)}
	}
	raw, _ := json.Marshal(map[string]any{"id": id, "title": title, "updated": updated, "messages": msgs})
	return string(raw)
}

func newStore(t *testing.T) (app *App, project string) {
	t.Helper()
	appData := t.TempDir()
	t.Setenv("AppData", appData)
	project = t.TempDir()
	app = &App{}
	app.SetChatFolder(project)
	t.Cleanup(func() { app.SetChatFolder("") })
	return app, project
}

func TestChatSaveLoadListDelete(t *testing.T) {
	app, project := newStore(t)

	if err := app.SaveChat("chat-1", chatDoc("chat-1", "第一組對話", 1000, 3)); err != nil {
		t.Fatalf("SaveChat: %v", err)
	}
	if err := app.SaveChat("chat-2", chatDoc("chat-2", "第二組對話", 2000, 5)); err != nil {
		t.Fatalf("SaveChat: %v", err)
	}

	// 檔案放在專案的 .DocSmith\chats 下，而且不是明文
	stored := filepath.Join(project, chatDirName, "chats", "chat-1"+chatExt)
	raw, err := os.ReadFile(stored)
	if err != nil {
		t.Fatalf("對話檔不在專案目錄：%v", err)
	}
	if strings.Contains(string(raw), "第一組對話") {
		t.Error("對話檔看得到明文，應該要是加密後的內容")
	}

	// .gitignore 會自己排除自己
	ignore, err := os.ReadFile(filepath.Join(project, chatDirName, ".gitignore"))
	if err != nil || strings.TrimSpace(string(ignore)) != "*" {
		t.Errorf(".gitignore 不正確：%q, %v", string(ignore), err)
	}

	// 讀回來要一模一樣
	got, err := app.LoadChat("chat-1")
	if err != nil || got != chatDoc("chat-1", "第一組對話", 1000, 3) {
		t.Errorf("LoadChat 內容不符：%v", err)
	}

	// 清單依更新時間由新到舊
	metas, err := app.ListChats()
	if err != nil {
		t.Fatalf("ListChats: %v", err)
	}
	if len(metas) != 2 || metas[0].ID != "chat-2" || metas[0].Count != 5 || metas[1].Title != "第一組對話" {
		t.Errorf("清單不正確：%+v", metas)
	}

	if err := app.DeleteChat("chat-1"); err != nil {
		t.Fatalf("DeleteChat: %v", err)
	}
	if metas, _ := app.ListChats(); len(metas) != 1 {
		t.Errorf("刪除後應該只剩一組，實際 %d", len(metas))
	}
	left, _ := filepath.Glob(filepath.Join(os.Getenv("AppData"), productID, "chats-backup", "*", "chat-1.json"))
	if len(left) > 0 {
		t.Errorf("刪除時沒有一併刪掉明文備援：%v", left)
	}
	kept, _ := filepath.Glob(filepath.Join(os.Getenv("AppData"), productID, "chats-backup", "*", "chat-2.json"))
	if len(kept) != 1 {
		t.Errorf("另一組的明文備援應該還在，實際 %v", kept)
	}
}

func TestChatFallsBackToPlainBackup(t *testing.T) {
	app, project := newStore(t)
	data := chatDoc("chat-x", "重要對話", 3000, 2)
	if err := app.SaveChat("chat-x", data); err != nil {
		t.Fatalf("SaveChat: %v", err)
	}

	// 模擬換帳號 / 檔案損毀：主檔解不開
	stored := filepath.Join(project, chatDirName, "chats", "chat-x"+chatExt)
	if err := os.WriteFile(stored, []byte("這不是有效的加密內容"), 0o600); err != nil {
		t.Fatal(err)
	}

	got, err := app.LoadChat("chat-x")
	if err != nil || got != data {
		t.Errorf("主檔壞掉時沒有改讀明文備援：%v", err)
	}
	metas, err := app.ListChats()
	if err != nil || len(metas) != 1 || !metas[0].Backup || metas[0].Title != "重要對話" {
		t.Errorf("清單沒有從備援補回來：%+v, %v", metas, err)
	}
}

func TestChatPrunesOldest(t *testing.T) {
	app, _ := newStore(t)
	for i := 0; i < chatMaxPerRoot+5; i++ {
		id := fmt.Sprintf("chat-%03d", i)
		if err := app.SaveChat(id, chatDoc(id, id, int64(i+1)*1000, 1)); err != nil {
			t.Fatalf("SaveChat %s: %v", id, err)
		}
	}
	metas, err := app.ListChats()
	if err != nil {
		t.Fatal(err)
	}
	if len(metas) != chatMaxPerRoot {
		t.Errorf("應該只留 %d 組，實際 %d", chatMaxPerRoot, len(metas))
	}
	if metas[len(metas)-1].ID != "chat-005" {
		t.Errorf("刪掉的應該是最舊的幾組，最舊的剩 %s", metas[len(metas)-1].ID)
	}
}

func TestChatFallsBackToAppDataWithoutFolder(t *testing.T) {
	app, _ := newStore(t)
	app.SetChatFolder("") // 沒有開啟資料夾
	if err := app.SaveChat("chat-a", chatDoc("chat-a", "沒有資料夾", 1000, 1)); err != nil {
		t.Fatalf("SaveChat: %v", err)
	}
	want := filepath.Join(os.Getenv("AppData"), productID, "chats")
	if app.ChatFolder() != want {
		t.Errorf("沒有資料夾時應該存到 %s，實際 %s", want, app.ChatFolder())
	}
	if _, err := os.Stat(filepath.Join(want, "chat-a"+chatExt)); err != nil {
		t.Errorf("檔案沒有存到 %%APPDATA%%：%v", err)
	}
}

func TestChatCompresses(t *testing.T) {
	app, project := newStore(t)
	data := chatDoc("chat-big", "很長的對話", 1000, 200)
	if err := app.SaveChat("chat-big", data); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(project, chatDirName, "chats", "chat-big"+chatExt))
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() >= int64(len(data))/2 {
		t.Errorf("壓縮效果不如預期：原始 %d 位元組，存檔 %d 位元組", len(data), info.Size())
	}
}

func TestChatFoldersAreIsolated(t *testing.T) {
	app, projectA := newStore(t)
	projectB := t.TempDir()

	if err := app.SaveChat("chat-a", chatDoc("chat-a", "A 專案的對話", 1000, 2)); err != nil {
		t.Fatal(err)
	}
	app.SetChatFolder(projectB)
	if metas, err := app.ListChats(); err != nil || len(metas) != 0 {
		t.Errorf("換資料夾後不應該看到 A 的對話：%+v, %v", metas, err)
	}
	if err := app.SaveChat("chat-b", chatDoc("chat-b", "B 專案的對話", 2000, 2)); err != nil {
		t.Fatal(err)
	}
	if metas, _ := app.ListChats(); len(metas) != 1 || metas[0].Title != "B 專案的對話" {
		t.Errorf("B 資料夾的清單不正確：%+v", metas)
	}
	app.SetChatFolder(projectA)
	if metas, _ := app.ListChats(); len(metas) != 1 || metas[0].Title != "A 專案的對話" {
		t.Errorf("切回 A 之後清單不正確：%+v", metas)
	}
}
