package engine

import (
	"bytes"
	"encoding/json"
	"strings"
)

// Completion inspection is deliberately independent of forwarding: even an
// oversized or malformed event is forwarded untouched, but cannot validate a
// ticket. Each individual buffer is bounded.
const maxObservedFrame = 1 << 20

type completionObserver struct {
	expected                                  string
	actual                                    string
	line, event, body                         []byte
	lineOverflow, eventOverflow, bodyOverflow bool
	complete, matches                         bool
}

func newCompletionObserver(expected string) *completionObserver {
	return &completionObserver{expected: expected, matches: true}
}

func (o *completionObserver) Write(p []byte) {
	if !o.bodyOverflow {
		if len(o.body)+len(p) > maxObservedFrame {
			o.body, o.bodyOverflow = nil, true
		} else {
			o.body = append(o.body, p...)
		}
	}
	for _, b := range p {
		if b == '\n' {
			o.consumeLine()
			continue
		}
		if o.lineOverflow {
			continue
		}
		if len(o.line) >= maxObservedFrame {
			o.line, o.lineOverflow = nil, true
			continue
		}
		o.line = append(o.line, b)
	}
}

func (o *completionObserver) consumeLine() {
	if o.lineOverflow {
		o.eventOverflow = true
		o.lineOverflow = false
		o.line = o.line[:0]
		return
	}
	line := bytes.TrimSuffix(o.line, []byte{'\r'})
	if len(line) == 0 {
		o.consumeEvent()
	} else if bytes.HasPrefix(line, []byte("data:")) && !o.eventOverflow {
		data := line[5:]
		if len(data) > 0 && data[0] == ' ' {
			data = data[1:]
		}
		if len(o.event)+len(data)+1 > maxObservedFrame {
			o.event, o.eventOverflow = nil, true
		} else {
			o.event = append(o.event, data...)
			o.event = append(o.event, '\n')
		}
	}
	o.line = o.line[:0]
}

func (o *completionObserver) consumeEvent() {
	if !o.eventOverflow && len(o.event) > 0 {
		o.inspect(o.event)
	}
	o.event = o.event[:0]
	o.eventOverflow = false
}

func (o *completionObserver) Finish() {
	if len(o.line) > 0 || o.lineOverflow {
		o.consumeLine()
	}
	o.consumeEvent()
	if !o.bodyOverflow {
		o.inspect(o.body)
	}
}

func (o *completionObserver) Result() (complete bool, matches bool) {
	return o.complete, o.complete && o.matches
}

func (o *completionObserver) inspect(data []byte) {
	if len(data) == 0 || len(data) > maxObservedFrame {
		return
	}
	var value struct {
		Type     string          `json:"type"`
		Object   string          `json:"object"`
		Status   string          `json:"status"`
		Model    string          `json:"model"`
		Error    json.RawMessage `json:"error"`
		Response *struct {
			Status string          `json:"status"`
			Model  string          `json:"model"`
			Error  json.RawMessage `json:"error"`
		} `json:"response"`
	}
	if json.Unmarshal(data, &value) != nil {
		return
	}
	model := ""
	if value.Type == "response.completed" && value.Response != nil && noResponseError(value.Error) && noResponseError(value.Response.Error) &&
		(value.Response.Status == "completed" || value.Response.Status == "") {
		model = value.Response.Model
	} else if value.Object == "response" && value.Status == "completed" && noResponseError(value.Error) {
		model = value.Model
	}
	if strings.TrimSpace(model) == "" {
		return
	}
	if modelPattern.MatchString(model) {
		o.actual = model
	}
	o.complete = true
	o.matches = o.matches && modelsCompatible(o.expected, model)
}

func noResponseError(raw json.RawMessage) bool {
	return len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

// modelsCompatible keeps model validation strict while allowing explicit,
// one-way aliases for upstream model renames. Do not replace this allowlist
// with prefix, suffix, or version-pattern matching: a nearby model name can
// represent a different route or entitlement.
func modelsCompatible(expected, actual string) bool {
	if expected == actual {
		return true
	}
	return expected == "gpt-5.6-sol" && actual == "gpt-6-sol"
}
