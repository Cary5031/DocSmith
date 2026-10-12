//go:build windows

package main

import (
	"strings"

	"golang.org/x/sys/windows/registry"
)

// aiPolicy 讀取公司政策（HKLM 優先，其次 HKCU）。
func aiPolicy() AIPolicy {
	policy := AIPolicy{}
	for _, root := range []registry.Key{registry.CURRENT_USER, registry.LOCAL_MACHINE} {
		k, err := registry.OpenKey(root, `SOFTWARE\Policies\`+productID, registry.QUERY_VALUE)
		if err != nil {
			continue
		}
		if v, _, err := k.GetIntegerValue("DisableAI"); err == nil && v != 0 {
			policy.Disabled = true
		}
		if v, _, err := k.GetStringValue("AllowedAIProviders"); err == nil && strings.TrimSpace(v) != "" {
			policy.AllowedProviders = nil
			for _, id := range strings.Split(v, ",") {
				if id = strings.TrimSpace(strings.ToLower(id)); aiDefaults[id] != "" || id == "custom" {
					policy.AllowedProviders = append(policy.AllowedProviders, id)
				}
			}
		}
		if v, _, err := k.GetStringValue("CustomBaseURL"); err == nil && strings.TrimSpace(v) != "" {
			policy.LockedBaseURL = strings.TrimSpace(v)
		}
		k.Close()
	}
	return policy
}
