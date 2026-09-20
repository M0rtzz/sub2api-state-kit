package engine

import (
	"fmt"
	"regexp"
	"strings"
	"time"
)

var countryMarkerPattern = regexp.MustCompile(`(?i)-country-([a-z]{2})(?:-|:|@|/|$)`)

func proxyCountryCode(raw string) string {
	match := countryMarkerPattern.FindStringSubmatch(raw)
	if len(match) != 2 {
		return ""
	}
	return strings.ToLower(match[1])
}

func proxyEntryName(country string, position int) string {
	if country != "" {
		return strings.ToUpper(country)
	}
	return fmt.Sprintf("Proxy %d", position)
}

// activeDynamicProxy resolves the current pool member without mutating config.
// Automatic mode is event driven: a ticket renewal or failed round advances
// the runtime offset instead of wall-clock time changing the country.
func activeDynamicProxy(c Config, now time.Time) (DynamicProxyEntry, time.Time, bool) {
	return activeDynamicProxyAt(c, now, 0)
}

func activeDynamicProxyAt(c Config, _ time.Time, advance int64) (DynamicProxyEntry, time.Time, bool) {
	if c.DynamicProxyMode == "manual" {
		if c.DynamicProxySelectedID != "" {
			for _, entry := range c.DynamicProxyEntries {
				if entry.ID == c.DynamicProxySelectedID {
					return entry, time.Time{}, true
				}
			}
		}
		if c.DynamicProxyURL != "" {
			country := proxyCountryCode(c.DynamicProxyURL)
			return DynamicProxyEntry{ID: "manual", Name: proxyEntryName(country, 1), CountryCode: country, URL: c.DynamicProxyURL}, time.Time{}, true
		}
		if len(c.DynamicProxyEntries) > 0 {
			return c.DynamicProxyEntries[0], time.Time{}, true
		}
		return DynamicProxyEntry{}, time.Time{}, false
	}

	if len(c.DynamicProxyEntries) == 0 {
		if c.DynamicProxyURL == "" {
			return DynamicProxyEntry{}, time.Time{}, false
		}
		country := proxyCountryCode(c.DynamicProxyURL)
		return DynamicProxyEntry{ID: "legacy", Name: proxyEntryName(country, 1), CountryCode: country, URL: c.DynamicProxyURL}, time.Time{}, true
	}
	if len(c.DynamicProxyEntries) == 1 {
		return c.DynamicProxyEntries[0], time.Time{}, true
	}
	index := int(advance % int64(len(c.DynamicProxyEntries)))
	if index < 0 {
		index += len(c.DynamicProxyEntries)
	}
	return c.DynamicProxyEntries[index], time.Time{}, true
}

func (e *Engine) dynamicProxyFor(c Config, now time.Time) (DynamicProxyEntry, time.Time, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return activeDynamicProxyAt(c, now, e.dynamicProxyAdvance)
}

// maybeAdvanceDynamicProxyForRenewalLocked starts a new country epoch when the
// first ticket to reach its refresh boundary becomes the renewal leader. Other
// tickets never advance the pool; the same leader can advance it again only
// after it has been replaced with a new ticket version and that version is due.
// The caller holds e.mu.
func (e *Engine) maybeAdvanceDynamicProxyForRenewalLocked(c Config, t *ticket, account AccountConfig, model string, now time.Time) bool {
	if c.DynamicProxyMode != "auto" || len(c.DynamicProxyEntries) < 2 || !ticketNeedsRenewal(t, c, account, model, now) {
		return false
	}
	key := keyFor(account.AccountID, model)
	if e.dynamicProxyRenewalLeader == "" {
		e.dynamicProxyRenewalLeader = key
	}
	if e.dynamicProxyRenewalLeader != key || e.dynamicProxyRenewalVersion == t.Version {
		return false
	}
	e.dynamicProxyAdvance = (e.dynamicProxyAdvance + 1) % int64(len(c.DynamicProxyEntries))
	e.dynamicProxyRenewalVersion = t.Version
	e.dynamicProxyAdvancedAt = now
	e.dynamicProxyAdvanceReason = "ticket_refresh_due"
	e.testedProxy = nil
	return true
}

func ticketNeedsRenewal(t *ticket, c Config, account AccountConfig, model string, now time.Time) bool {
	if t == nil || !ticketRefreshDue(t, c, now) {
		return false
	}
	checkAt := now
	if !now.Before(t.ExpiresAt) {
		checkAt = t.ExpiresAt.Add(-time.Nanosecond)
	}
	return validTicket(t, c, account, model, checkAt)
}

// maybeAdvanceDynamicProxyLocked advances one pool member at most once for a
// failed country epoch. The caller holds e.mu after a collection round ended.
func (e *Engine) maybeAdvanceDynamicProxyLocked(c Config, failedEntryID string, now time.Time) bool {
	if c.DynamicProxyMode != "auto" || len(c.DynamicProxyEntries) < 2 || failedEntryID == "" ||
		dynamicProxyNetworkFingerprint(c) != dynamicProxyNetworkFingerprint(e.config) {
		return false
	}
	current, _, ok := activeDynamicProxyAt(c, now, e.dynamicProxyAdvance)
	if !ok {
		return false
	}
	if current.ID != failedEntryID {
		// Another exhausted target may have already advanced this country epoch.
		// Do not skip a second country, but also do not let the late result put an
		// unavailable target back into cooldown before it can try the new country.
		e.resetUnavailableCooldownsLocked(c, now)
		e.notify()
		return false
	}
	total, ready := 0, 0
	for _, account := range e.config.Accounts {
		if !account.Enabled {
			continue
		}
		for _, model := range account.Models {
			total++
			if validTicket(e.tickets[keyFor(account.AccountID, model)], e.config, account, model, now) {
				ready++
			}
		}
	}
	// Five targets with one exhausted target means a 20% failure rate. Use
	// integer arithmetic so the rule is exact for any configured target count.
	if total == 0 || (total-ready)*100 < total*20 {
		return false
	}
	e.dynamicProxyAdvance = (e.dynamicProxyAdvance + 1) % int64(len(c.DynamicProxyEntries))
	e.bindRenewalLeaderAfterFailureLocked(c, now)
	e.dynamicProxyAdvancedAt = now
	e.dynamicProxyAdvanceReason = "failure_rate_20_percent"
	e.testedProxy = nil
	e.resetUnavailableCooldownsLocked(c, now)
	e.notify()
	return true
}

// A failure-rate advance consumes a simultaneously due leader transition. This
// prevents the scheduler from advancing again for the same old ticket while
// still allowing the leader's next successfully renewed version to advance.
func (e *Engine) bindRenewalLeaderAfterFailureLocked(c Config, now time.Time) {
	for _, account := range c.Accounts {
		if !account.Enabled {
			continue
		}
		for _, model := range account.Models {
			key := keyFor(account.AccountID, model)
			if e.dynamicProxyRenewalLeader != "" && e.dynamicProxyRenewalLeader != key {
				continue
			}
			t := e.tickets[key]
			if !ticketNeedsRenewal(t, c, account, model, now) {
				continue
			}
			e.dynamicProxyRenewalLeader = key
			e.dynamicProxyRenewalVersion = t.Version
			return
		}
	}
}

func dynamicProxyTargetConfigured(c Config, key string) bool {
	if key == "" {
		return true
	}
	for _, account := range c.Accounts {
		if !account.Enabled {
			continue
		}
		for _, model := range account.Models {
			if keyFor(account.AccountID, model) == key {
				return true
			}
		}
	}
	return false
}

func (e *Engine) resetUnavailableCooldownsLocked(c Config, now time.Time) {
	for _, account := range c.Accounts {
		if !account.Enabled {
			continue
		}
		for _, model := range account.Models {
			key := keyFor(account.AccountID, model)
			if record := e.records[key]; record != nil && !validTicket(e.tickets[key], c, account, model, now) {
				record.CooldownUntil = time.Time{}
			}
		}
	}
}

func dynamicProxyConfigFingerprint(c Config) string {
	// ParseConfig migrates a legacy single dynamic_proxy_url into a synthetic
	// list member. Preserve the pre-migration fingerprint so merely opening and
	// saving an old configuration does not invalidate an available ticket.
	if len(c.DynamicProxyEntries) == 0 ||
		(len(c.DynamicProxyEntries) == 1 && c.DynamicProxyEntries[0].ID == "legacy" && c.DynamicProxyEntries[0].URL == c.DynamicProxyURL) {
		return digest("dynamic-pool-v1", c.DynamicProxyURL)
	}
	parts := []string{"dynamic-pool-v1", c.DynamicProxyURL}
	for _, entry := range c.DynamicProxyEntries {
		parts = append(parts, entry.ID, entry.URL)
	}
	return digest(parts...)
}

func dynamicProxyNetworkFingerprint(c Config) string {
	return digest("dynamic-network-v1", dynamicProxyConfigFingerprint(c), c.DynamicProxyMode,
		c.DynamicProxySelectedID)
}
