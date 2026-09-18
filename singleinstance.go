package main

import (
	"encoding/json"
	"os"
	"runtime"
	"sync"
	"unsafe"

	"github.com/wailsapp/wails/v2/pkg/options"
	xwin "golang.org/x/sys/windows"
)

// 單一執行個體：程式已在執行時，把命令列參數（要開啟的檔案）轉交給既有的程式後結束。
// 不使用 Wails 內建的 SingleInstanceLock，因為它以沒有逾時的 SendMessage 轉交，
// 既有程式卡住時新開的程式也會永遠卡住；這裡改用 SendMessageTimeout，對方沒有回應就自己正常啟動。

const (
	wmCopyData         = 0x004A
	smtoAbortIfHung    = 0x0002
	smtoBlock          = 0x0001
	hwndMessage        = ^uintptr(2) // HWND_MESSAGE = (HWND)-3
	singleInstanceData = 0x44534D31  // 'DSM1'
)

var (
	procRegisterClassEx     = user32.NewProc("RegisterClassExW")
	procCreateWindowEx      = user32.NewProc("CreateWindowExW")
	procDefWindowProc       = user32.NewProc("DefWindowProcW")
	procGetMessage          = user32.NewProc("GetMessageW")
	procDispatchMessage     = user32.NewProc("DispatchMessageW")
	procFindWindowEx        = user32.NewProc("FindWindowExW")
	procSendMessageTimeout  = user32.NewProc("SendMessageTimeoutW")
	procGetModuleHandle     = xwin.NewLazySystemDLL("kernel32.dll").NewProc("GetModuleHandleW")
	secondInstanceMu        sync.Mutex
	secondInstanceHandler   func(options.SecondInstanceData)
	pendingSecondInstances  []options.SecondInstanceData
	singleInstanceClassName = "DocSmithSingleInstance-" + instanceLock
)

type copyDataStruct struct {
	dwData uintptr
	cbData uint32
	lpData uintptr
}

type wndClassEx struct {
	size       uint32
	style      uint32
	wndProc    uintptr
	clsExtra   int32
	wndExtra   int32
	instance   uintptr
	icon       uintptr
	cursor     uintptr
	background uintptr
	menuName   *uint16
	className  *uint16
	iconSm     uintptr
}

type winMsg struct {
	hwnd    uintptr
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	pt      struct{ x, y int32 }
}

// setSecondInstanceHandler 在程式啟動完成後設定；之前收到的轉交會先暫存再交付。
func setSecondInstanceHandler(fn func(options.SecondInstanceData)) {
	secondInstanceMu.Lock()
	secondInstanceHandler = fn
	pending := pendingSecondInstances
	pendingSecondInstances = nil
	secondInstanceMu.Unlock()
	for _, data := range pending {
		fn(data)
	}
}

func deliverSecondInstance(data options.SecondInstanceData) {
	secondInstanceMu.Lock()
	fn := secondInstanceHandler
	if fn == nil {
		pendingSecondInstances = append(pendingSecondInstances, data)
	}
	secondInstanceMu.Unlock()
	if fn != nil {
		go fn(data)
	}
}

// ensureSingleInstance 回傳 false 表示已把參數轉交給既有程式，本程式應直接結束。
func ensureSingleInstance() bool {
	name, _ := xwin.UTF16PtrFromString(`Local\DocSmithMutex-` + instanceLock)
	_, err := xwin.CreateMutex(nil, false, name)
	if err == xwin.ERROR_ALREADY_EXISTS && forwardToExisting() {
		return false
	}
	go runMessageWindow()
	return true
}

// forwardToExisting 依序嘗試既有程式的訊息視窗；任何一個在 3 秒內收下就算成功。
func forwardToExisting() bool {
	cwd, _ := os.Getwd()
	payload, _ := json.Marshal(options.SecondInstanceData{Args: os.Args[1:], WorkingDirectory: cwd})
	text, _ := xwin.UTF16FromString(string(payload))
	cds := copyDataStruct{dwData: singleInstanceData, cbData: uint32(len(text) * 2), lpData: uintptr(unsafe.Pointer(&text[0]))}
	class, _ := xwin.UTF16PtrFromString(singleInstanceClassName)
	var after uintptr
	for {
		hwnd, _, _ := procFindWindowEx.Call(hwndMessage, after, uintptr(unsafe.Pointer(class)), 0)
		if hwnd == 0 {
			return false
		}
		var result uintptr
		ok, _, _ := procSendMessageTimeout.Call(hwnd, wmCopyData, 0, uintptr(unsafe.Pointer(&cds)),
			smtoAbortIfHung|smtoBlock, 3000, uintptr(unsafe.Pointer(&result)))
		if ok != 0 && result == 1 {
			return true
		}
		after = hwnd
	}
}

// runMessageWindow 建立只收訊息的隱藏視窗，接收其他執行個體轉交的檔案。
func runMessageWindow() {
	runtime.LockOSThread()
	instance, _, _ := procGetModuleHandle.Call(0)
	className, _ := xwin.UTF16PtrFromString(singleInstanceClassName)
	wndProc := xwin.NewCallback(func(hwnd uintptr, msg uint32, wParam, lParam uintptr) uintptr {
		if msg == wmCopyData {
			cds := (*copyDataStruct)(unsafe.Pointer(lParam))
			if cds.dwData == singleInstanceData && cds.cbData > 0 {
				text := unsafe.Slice((*uint16)(unsafe.Pointer(cds.lpData)), cds.cbData/2)
				var data options.SecondInstanceData
				if json.Unmarshal([]byte(xwin.UTF16ToString(text)), &data) == nil {
					deliverSecondInstance(data)
					return 1
				}
			}
			return 0
		}
		r, _, _ := procDefWindowProc.Call(hwnd, uintptr(msg), wParam, lParam)
		return r
	})
	class := wndClassEx{wndProc: wndProc, instance: instance, className: className}
	class.size = uint32(unsafe.Sizeof(class))
	procRegisterClassEx.Call(uintptr(unsafe.Pointer(&class)))
	hwnd, _, _ := procCreateWindowEx.Call(0, uintptr(unsafe.Pointer(className)), 0, 0, 0, 0, 0, 0, hwndMessage, 0, instance, 0)
	if hwnd == 0 {
		return
	}
	var m winMsg
	for {
		r, _, _ := procGetMessage.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if r == 0 || int32(r) == -1 {
			return
		}
		procDispatchMessage.Call(uintptr(unsafe.Pointer(&m)))
	}
}
