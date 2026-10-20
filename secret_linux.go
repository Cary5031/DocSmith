//go:build !windows

package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// Linux 沒有 DPAPI。金鑰放在設定目錄（不跟專案走），複製專案資料夾仍讀不到對話與 API 金鑰。

func secretKey() ([]byte, error) {
	path := filepath.Join(configDir(), "secret.key")
	if b, err := os.ReadFile(path); err == nil && len(b) == 32 {
		return b, nil
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(configDir(), 0o700); err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, b, 0o600); err != nil {
		return nil, err
	}
	return b, nil
}

func sealBytes(plain []byte) ([]byte, error) {
	key, err := secretKey()
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return append(nonce, gcm.Seal(nil, nonce, plain, nil)...), nil
}

func openBytes(sealed []byte) ([]byte, error) {
	key, err := secretKey()
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(sealed) < gcm.NonceSize() {
		return nil, errors.New("sealed data is too short")
	}
	nonce, ciphertext := sealed[:gcm.NonceSize()], sealed[gcm.NonceSize():]
	plain, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, fmt.Errorf("decrypt: %w", err)
	}
	return plain, nil
}

func encryptSecret(plain string) string {
	if plain == "" {
		return ""
	}
	sealed, err := sealBytes([]byte(plain))
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
	plain, err := openBytes(raw)
	if err != nil {
		return ""
	}
	return string(plain)
}

func protectBytes(raw []byte) ([]byte, error) { return sealBytes(raw) }

func unprotectBytes(raw []byte) ([]byte, error) { return openBytes(raw) }
