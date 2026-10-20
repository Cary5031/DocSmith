//go:build windows

package main

import (
	"encoding/base64"
	"fmt"
	"unsafe"

	xwin "golang.org/x/sys/windows"
)

var (
	crypt32           = xwin.NewLazySystemDLL("crypt32.dll")
	procCryptProtect  = crypt32.NewProc("CryptProtectData")
	procCryptUnprotec = crypt32.NewProc("CryptUnprotectData")
)

type dataBlob struct {
	size uint32
	data *byte
}

func newBlob(b []byte) dataBlob {
	if len(b) == 0 {
		return dataBlob{}
	}
	return dataBlob{size: uint32(len(b)), data: &b[0]}
}

func (b dataBlob) bytes() []byte {
	if b.size == 0 || b.data == nil {
		return nil
	}
	out := make([]byte, b.size)
	copy(out, unsafe.Slice(b.data, b.size))
	return out
}

// encryptSecret 以目前 Windows 帳號加密（DPAPI），輸出 base64。
func encryptSecret(plain string) string {
	if plain == "" {
		return ""
	}
	sealed, err := protectBytes([]byte(plain))
	if err != nil {
		return ""
	}
	return base64.StdEncoding.EncodeToString(sealed)
}

func decryptSecret(encoded string) string {
	if encoded == "" {
		return ""
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return ""
	}
	plain, err := unprotectBytes(raw)
	if err != nil {
		return ""
	}
	return string(plain)
}

func protectBytes(raw []byte) ([]byte, error) {
	in := newBlob(raw)
	var out dataBlob
	r, _, err := procCryptProtect.Call(uintptr(unsafe.Pointer(&in)), 0, 0, 0, 0, 0, uintptr(unsafe.Pointer(&out)))
	if r == 0 {
		return nil, fmt.Errorf("CryptProtectData: %v", err)
	}
	defer xwin.LocalFree(xwin.Handle(unsafe.Pointer(out.data)))
	return out.bytes(), nil
}

func unprotectBytes(raw []byte) ([]byte, error) {
	in := newBlob(raw)
	var out dataBlob
	r, _, err := procCryptUnprotec.Call(uintptr(unsafe.Pointer(&in)), 0, 0, 0, 0, 0, uintptr(unsafe.Pointer(&out)))
	if r == 0 {
		return nil, fmt.Errorf("CryptUnprotectData: %v", err)
	}
	defer xwin.LocalFree(xwin.Handle(unsafe.Pointer(out.data)))
	return out.bytes(), nil
}
