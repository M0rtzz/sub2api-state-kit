package engine

import (
	"strings"
	"testing"
)

func TestCompletionObserverRequiresSuccessfulActualModel(t *testing.T) {
	tests := []struct {
		name, body        string
		complete, matches bool
	}{
		{"completed SSE", "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"model\":\"gpt-test\"}}\n\n", true, true},
		{"wrong actual model", `data: {"type":"response.completed","response":{"status":"completed","model":"gpt-other"}}` + "\n\n", true, false},
		{"failed completion", `data: {"type":"response.completed","response":{"status":"failed","model":"gpt-test"}}` + "\n\n", false, false},
		{"completed with error", `data: {"type":"response.completed","response":{"status":"completed","model":"gpt-test","error":{"code":"failed"}}}` + "\n\n", false, false},
		{"missing actual model", `data: {"type":"response.completed","response":{"status":"completed"}}` + "\n\n", false, false},
		{"created is not complete", `data: {"type":"response.created","response":{"status":"completed","model":"gpt-test"}}` + "\n\n", false, false},
		{"plain JSON", `{"object":"response","status":"completed","model":"gpt-test"}`, true, true},
		{"incomplete JSON", `{"object":"response","status":"in_progress","model":"gpt-test"}`, false, false},
		{"snapshot must match exactly", `{"object":"response","status":"completed","model":"gpt-test-2026-09-01"}`, true, false},
		{"garbage", `data: [DONE]` + "\n\n", false, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			for chunkSize := 1; chunkSize <= len(tc.body)+1; chunkSize += 13 {
				o := newCompletionObserver("gpt-test")
				for pos := 0; pos < len(tc.body); pos += chunkSize {
					end := pos + chunkSize
					if end > len(tc.body) {
						end = len(tc.body)
					}
					o.Write([]byte(tc.body[pos:end]))
				}
				o.Finish()
				complete, matches := o.Result()
				if complete != tc.complete || matches != tc.matches {
					t.Fatalf("chunks %d: got (%v,%v), want (%v,%v)", chunkSize, complete, matches, tc.complete, tc.matches)
				}
			}
		})
	}
}

func TestCompletionObserverOversizeIsBoundedAndRecoversAtNextEvent(t *testing.T) {
	o := newCompletionObserver("gpt-test")
	o.Write([]byte("data: " + strings.Repeat("x", maxObservedFrame+100) + "\n\n"))
	if len(o.body) > maxObservedFrame || len(o.line) > maxObservedFrame || len(o.event) > maxObservedFrame {
		t.Fatal("unbounded observer buffer")
	}
	o.Write([]byte("data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"model\":\"gpt-test\"}}\r\n\r\n"))
	o.Finish()
	if complete, matches := o.Result(); !complete || !matches {
		t.Fatal("did not recover after ignored oversized event")
	}
}

func TestCompletionObserverMismatchCannotBeHiddenByLaterMatch(t *testing.T) {
	o := newCompletionObserver("gpt-test")
	for _, model := range []string{"gpt-other", "gpt-test"} {
		o.Write([]byte(`data: {"type":"response.completed","response":{"model":"` + model + `"}}` + "\n\n"))
	}
	o.Finish()
	if complete, matches := o.Result(); !complete || matches {
		t.Fatal("later match hid a mismatch")
	}
}

func TestCompletionObserverUsesExplicitOneWayModelAliases(t *testing.T) {
	tests := []struct {
		name, expected, actual string
		matches                bool
	}{
		{"exact model", "gpt-5.6-sol", "gpt-5.6-sol", true},
		{"supported rename", "gpt-5.6-sol", "gpt-6-sol", true},
		{"reverse rename is rejected", "gpt-6-sol", "gpt-5.6-sol", false},
		{"snapshot suffix is rejected", "gpt-5.6-sol", "gpt-6-sol-2026-09-20", false},
		{"nearby model is rejected", "gpt-5.6-sol", "gpt-6-astra", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			o := newCompletionObserver(tc.expected)
			o.Write([]byte(`data: {"type":"response.completed","response":{"status":"completed","model":"` + tc.actual + `"}}` + "\n\n"))
			o.Finish()
			complete, matches := o.Result()
			if !complete || matches != tc.matches {
				t.Fatalf("got (%v,%v), want (true,%v)", complete, matches, tc.matches)
			}
			if o.actual != tc.actual {
				t.Fatalf("actual model = %q, want %q", o.actual, tc.actual)
			}
		})
	}
}
