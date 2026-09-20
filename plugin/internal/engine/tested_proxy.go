package engine

import (
	"fmt"
	"time"
)

// Only the short-lived proxy session is reused, never account credentials or
// STATE. Keep authenticated URLs in memory and out of status, logs and KV.
type testedProxySession struct {
	ConfigFingerprint string
	FrontFingerprint  string
	ActiveProxyID     string
	Route             string
	ExpiresAt         time.Time
}

const testedProxyLifetime = time.Minute

func networkFingerprint(c Config) string {
	return digest("tested-proxy-v2", dynamicProxyNetworkFingerprint(c), frontProxyMode(c),
		fmt.Sprint(c.HarvestDialProxyID), c.HarvestDialProxyURL)
}

func (e *Engine) rememberTestedProxy(id string, c Config, route, outer string, started time.Time) string {
	e.mu.Lock()
	defer e.mu.Unlock()
	expires := started.Add(testedProxyLifetime)
	if e.closed || !time.Now().Before(expires) || e.manual == nil || e.manual.ID != id || !e.manual.Running {
		return ""
	}
	active, _, ok := activeDynamicProxyAt(c, started, e.dynamicProxyAdvance)
	if !ok {
		return ""
	}
	e.testedProxy = &testedProxySession{ConfigFingerprint: networkFingerprint(c),
		FrontFingerprint: proxyFingerprint(outer), ActiveProxyID: active.ID, Route: route, ExpiresAt: expires}
	return expires.UTC().Format(time.RFC3339)
}

func (e *Engine) testedProxyRoute(c Config, outer string) string {
	e.mu.Lock()
	defer e.mu.Unlock()
	p := e.testedProxy
	if p == nil {
		return ""
	}
	if !time.Now().Before(p.ExpiresAt) {
		e.testedProxy = nil
		return ""
	}
	if p.ConfigFingerprint != networkFingerprint(c) || p.FrontFingerprint != proxyFingerprint(outer) {
		return ""
	}
	active, _, ok := activeDynamicProxyAt(c, time.Now(), e.dynamicProxyAdvance)
	if !ok || active.ID != p.ActiveProxyID {
		return ""
	}
	return p.Route
}

func (e *Engine) discardTestedProxy(route string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.testedProxy != nil && e.testedProxy.Route == route {
		e.testedProxy = nil
	}
}
