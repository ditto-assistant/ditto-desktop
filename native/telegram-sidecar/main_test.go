package main

import (
	"errors"
	"fmt"
	"testing"
)

func TestProtocolErrorCode(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		err  error
		want string
	}{
		{name: "not connected", err: errNotConnected, want: "not_connected"},
		{name: "wrapped not connected", err: fmt.Errorf("restore: %w", errNotConnected), want: "not_connected"},
		{name: "other", err: errors.New("provider detail"), want: "operation_failed"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := protocolErrorCode(tt.err); got != tt.want {
				t.Fatalf("protocolErrorCode() = %q, want %q", got, tt.want)
			}
		})
	}
}
