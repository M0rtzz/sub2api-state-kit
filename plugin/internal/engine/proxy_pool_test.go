package engine

import (
	"fmt"
	"testing"
	"time"
)

func proxyPoolConfig(modelCount int) Config {
	models := make([]string, modelCount)
	for i := range models {
		models[i] = fmt.Sprintf("gpt-pool-%d", i+1)
	}
	return Config{
		Enabled:              true,
		AutoHarvest:          true,
		AllowWithoutTicket:   true,
		HarvestDialProxyMode: "direct",
		DynamicProxyMode:     "auto",
		DynamicProxyEntries: []DynamicProxyEntry{
			{ID: "de", Name: "Germany", CountryCode: "de", URL: "socks5://user-country-de:secret@192.0.2.10:11000"},
			{ID: "sg", Name: "Singapore", CountryCode: "sg", URL: "socks5://user-country-sg:secret@192.0.2.10:11000"},
			{ID: "fr", Name: "France", CountryCode: "fr", URL: "socks5://user-country-fr:secret@192.0.2.11:11000"},
		},
		TTLMinutes:             60,
		RefreshBeforeMinutes:   10,
		MaxAttempts:            8,
		AttemptIntervalSeconds: 10,
		CooldownSeconds:        300,
		Accounts: []AccountConfig{{
			AccountID: 7,
			Enabled:   true,
			Plan:      "pro",
			Models:    models,
		}},
	}
}

func readyPoolTicket(c Config, account AccountConfig, model string, now time.Time) *ticket {
	return &ticket{
		AccountID:           account.AccountID,
		Model:               model,
		Plan:                account.Plan,
		State:               testState(targetLength(account.Plan)),
		Version:             "ready-" + model,
		ConfigFingerprint:   configFingerprint(c, account, model),
		FixedFingerprint:    proxyFingerprint("http://business.example:8080"),
		IdentityFingerprint: "stable-identity",
		CapturedAt:          now.Add(-time.Minute),
		ExpiresAt:           now.Add(30 * time.Minute),
		RefreshAt:           now.Add(20 * time.Minute),
	}
}

func TestDynamicProxyPoolDoesNotRotateWithWallClock(t *testing.T) {
	c := proxyPoolConfig(5)
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for _, at := range []time.Time{now, now.Add(time.Hour), now.Add(30 * 24 * time.Hour)} {
		entry, next, ok := activeDynamicProxy(c, at)
		if !ok || entry.ID != "de" || !next.IsZero() {
			t.Fatalf("wall clock changed the automatic proxy at %s: %+v", at, entry)
		}
	}
}

func TestDynamicProxyPoolOnlyRenewalLeaderAdvancesEachGeneration(t *testing.T) {
	c := proxyPoolConfig(5)
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	e := &Engine{config: c, tickets: map[string]*ticket{}, records: map[string]*jobRecord{}, wake: make(chan struct{}, 1)}
	account := c.Accounts[0]
	due := func(model, version string) *ticket {
		ticket := readyPoolTicket(c, account, model, now)
		ticket.Version = version
		ticket.CapturedAt = now.Add(-50 * time.Minute)
		ticket.ExpiresAt = now.Add(10 * time.Minute)
		ticket.RefreshAt = now
		return ticket
	}
	leader := due(account.Models[0], "leader-v1")
	follower := due(account.Models[1], "follower-v1")
	if !e.maybeAdvanceDynamicProxyForRenewalLocked(c, leader, account, account.Models[0], now) {
		t.Fatal("the first due ticket did not become leader and advance")
	}
	if e.maybeAdvanceDynamicProxyForRenewalLocked(c, follower, account, account.Models[1], now.Add(time.Minute)) {
		t.Fatal("a later ticket from the same batch skipped another country")
	}
	if e.maybeAdvanceDynamicProxyForRenewalLocked(c, leader, account, account.Models[0], now.Add(2*time.Minute)) {
		t.Fatal("the same old leader ticket advanced more than once")
	}
	active, _, _ := activeDynamicProxyAt(c, now, e.dynamicProxyAdvance)
	if active.ID != "sg" {
		t.Fatalf("same renewal batch should remain on SG, got %s", active.ID)
	}

	// Only a newly acquired version of the same leader can advance again.
	later := now.Add(52 * time.Minute)
	leaderV2 := readyPoolTicket(c, account, account.Models[0], now)
	leaderV2.Version = "leader-v2"
	leaderV2.CapturedAt = now.Add(2 * time.Minute)
	leaderV2.ExpiresAt = now.Add(62 * time.Minute)
	leaderV2.RefreshAt = later
	if e.maybeAdvanceDynamicProxyForRenewalLocked(c, follower, account, account.Models[1], later) {
		t.Fatal("the follower replaced the renewal leader")
	}
	if !e.maybeAdvanceDynamicProxyForRenewalLocked(c, leaderV2, account, account.Models[0], later) {
		t.Fatal("the renewed leader did not advance on its next refresh boundary")
	}
	active, _, _ = activeDynamicProxyAt(c, later, e.dynamicProxyAdvance)
	if active.ID != "fr" {
		t.Fatalf("second leader generation should select FR, got %s", active.ID)
	}
	leaderV3 := readyPoolTicket(c, account, account.Models[0], later)
	leaderV3.Version = "leader-v3"
	leaderV3.CapturedAt = later
	leaderV3.ExpiresAt = later.Add(60 * time.Minute)
	leaderV3.RefreshAt = later.Add(50 * time.Minute)
	thirdDue := later.Add(50 * time.Minute)
	if !e.maybeAdvanceDynamicProxyForRenewalLocked(c, leaderV3, account, account.Models[0], thirdDue) {
		t.Fatal("third leader generation did not advance")
	}
	active, _, _ = activeDynamicProxyAt(c, thirdDue, e.dynamicProxyAdvance)
	if active.ID != "de" {
		t.Fatalf("leader cycle did not wrap from FR to DE, got %s", active.ID)
	}
}

func TestDynamicProxyPoolManualSelectionAndCustomURL(t *testing.T) {
	c := proxyPoolConfig(5)
	c.DynamicProxyMode = "manual"
	c.DynamicProxySelectedID = "fr"
	entry, next, ok := activeDynamicProxy(c, time.Now())
	if !ok || entry.ID != "fr" || !next.IsZero() {
		t.Fatalf("manual selection = %+v, %s, %v", entry, next, ok)
	}

	raw := `{"dynamic_proxy_mode":"manual","dynamic_proxy_selected_id":"custom","dynamic_proxy_entries":[{"id":"custom","name":"Custom","url":"socks5://user-country-jp:secret@198.51.100.7:1080"}]}`
	parsed, err := ParseConfig([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if len(parsed.DynamicProxyEntries) != 1 || parsed.DynamicProxyEntries[0].URL != "socks5://user-country-jp:secret@198.51.100.7:1080" || parsed.DynamicProxyEntries[0].CountryCode != "jp" {
		t.Fatalf("custom proxy was not preserved and classified: %+v", parsed.DynamicProxyEntries)
	}
}

func TestDynamicProxyPoolAdvancesAtTwentyPercentUnavailable(t *testing.T) {
	c := proxyPoolConfig(5)
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	e := &Engine{config: c, tickets: map[string]*ticket{}, records: map[string]*jobRecord{}, wake: make(chan struct{}, 1)}
	account := c.Accounts[0]
	for i, model := range account.Models {
		key := keyFor(account.AccountID, model)
		e.records[key] = &jobRecord{CooldownUntil: now.Add(time.Hour)}
		if i < 4 {
			e.tickets[key] = readyPoolTicket(c, account, model, now)
		}
	}
	failedKey := keyFor(account.AccountID, account.Models[4])
	if !e.maybeAdvanceDynamicProxyLocked(c, "de", now) {
		t.Fatal("one unavailable target out of five did not advance the country")
	}
	active, _, _ := activeDynamicProxyAt(c, now, e.dynamicProxyAdvance)
	if active.ID != "sg" || !e.records[failedKey].CooldownUntil.IsZero() {
		t.Fatalf("advance did not select SG and immediately retry the failed target: active=%s cooldown=%s", active.ID, e.records[failedKey].CooldownUntil)
	}
	if e.tickets[keyFor(account.AccountID, account.Models[0])] == nil {
		t.Fatal("advancing the country invalidated an available ticket")
	}

	// A concurrent job that exhausted the old country after the first advance
	// must be retried on SG without advancing again to FR.
	e.records[failedKey].CooldownUntil = now.Add(time.Hour)
	if e.maybeAdvanceDynamicProxyLocked(c, "de", now) {
		t.Fatal("a late result from the old country advanced more than once")
	}
	active, _, _ = activeDynamicProxyAt(c, now, e.dynamicProxyAdvance)
	if active.ID != "sg" || !e.records[failedKey].CooldownUntil.IsZero() {
		t.Fatalf("late old-country failure was not retried on the current country: active=%s cooldown=%s", active.ID, e.records[failedKey].CooldownUntil)
	}
}

func TestFailureRateAdvanceConsumesSimultaneousLeaderRenewal(t *testing.T) {
	c := proxyPoolConfig(5)
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	e := &Engine{config: c, tickets: map[string]*ticket{}, records: map[string]*jobRecord{}, wake: make(chan struct{}, 1)}
	account := c.Accounts[0]
	for i, model := range account.Models {
		if i == 4 {
			continue
		}
		ticket := readyPoolTicket(c, account, model, now)
		if i == 0 {
			ticket.Version = "leader-current"
			ticket.CapturedAt = now.Add(-50 * time.Minute)
			ticket.ExpiresAt = now.Add(10 * time.Minute)
			ticket.RefreshAt = now
			e.dynamicProxyRenewalLeader = keyFor(account.AccountID, model)
			e.dynamicProxyRenewalVersion = "leader-previous"
		}
		e.tickets[keyFor(account.AccountID, model)] = ticket
	}
	if !e.maybeAdvanceDynamicProxyLocked(c, "de", now) {
		t.Fatal("20 percent failure did not advance the country")
	}
	leader := e.tickets[keyFor(account.AccountID, account.Models[0])]
	if e.maybeAdvanceDynamicProxyForRenewalLocked(c, leader, account, account.Models[0], now) {
		t.Fatal("the same due leader caused a second advance after failure-rate failover")
	}
	active, _, _ := activeDynamicProxyAt(c, now, e.dynamicProxyAdvance)
	if active.ID != "sg" {
		t.Fatalf("failure and renewal conflict skipped a country, got %s", active.ID)
	}
}

func TestRenewalAdvanceStillAllowsFailureRateFailoverWithoutDoubleAdvance(t *testing.T) {
	c := proxyPoolConfig(5)
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	e := &Engine{config: c, tickets: map[string]*ticket{}, records: map[string]*jobRecord{}, wake: make(chan struct{}, 1)}
	account := c.Accounts[0]
	for i, model := range account.Models {
		if i == 4 {
			continue
		}
		ticket := readyPoolTicket(c, account, model, now)
		if i == 0 {
			ticket.Version = "leader-current"
			ticket.CapturedAt = now.Add(-50 * time.Minute)
			ticket.ExpiresAt = now.Add(10 * time.Minute)
			ticket.RefreshAt = now
		}
		e.tickets[keyFor(account.AccountID, model)] = ticket
	}
	leader := e.tickets[keyFor(account.AccountID, account.Models[0])]
	if !e.maybeAdvanceDynamicProxyForRenewalLocked(c, leader, account, account.Models[0], now) {
		t.Fatal("due renewal leader did not advance from DE to SG")
	}
	if !e.maybeAdvanceDynamicProxyLocked(c, "sg", now) {
		t.Fatal("20 percent failure on the renewal-selected country did not advance to FR")
	}
	active, _, _ := activeDynamicProxyAt(c, now, e.dynamicProxyAdvance)
	if active.ID != "fr" {
		t.Fatalf("renewal plus a genuine failure-rate failover should select FR, got %s", active.ID)
	}
	if e.maybeAdvanceDynamicProxyForRenewalLocked(c, leader, account, account.Models[0], now) {
		t.Fatal("failure-rate failover did not consume the same leader generation")
	}
	if e.maybeAdvanceDynamicProxyLocked(c, "sg", now) {
		t.Fatal("late failure from the previous country skipped another country")
	}
	active, _, _ = activeDynamicProxyAt(c, now, e.dynamicProxyAdvance)
	if active.ID != "fr" {
		t.Fatalf("deduplication did not hold the active country at FR, got %s", active.ID)
	}
}

func TestDynamicProxyPoolDoesNotAdvanceBelowTwentyPercent(t *testing.T) {
	c := proxyPoolConfig(6)
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	e := &Engine{config: c, tickets: map[string]*ticket{}, records: map[string]*jobRecord{}, wake: make(chan struct{}, 1)}
	account := c.Accounts[0]
	for i, model := range account.Models {
		if i < 5 {
			e.tickets[keyFor(account.AccountID, model)] = readyPoolTicket(c, account, model, now)
		}
	}
	if e.maybeAdvanceDynamicProxyLocked(c, "de", now) || e.dynamicProxyAdvance != 0 {
		t.Fatal("one unavailable target out of six incorrectly advanced the country")
	}
}
