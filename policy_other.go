//go:build !windows

package main

// aiPolicy 在 Linux 沒有對應的群組原則，AI 維持可用。
func aiPolicy() AIPolicy { return AIPolicy{} }
