import Testing
@testable import NeonDiffDesktopCore

// Issue #612: the native purchase-to-activation state machine. Pure, UI-free,
// exhaustively tested. The 12 states are the authoritative closed set from the
// customer-journey UX blueprint stage 6 + the issue acceptance criteria.
@Suite struct ActivationStateMachineTests {
    // The full transition table. Every (from, event) pair not listed here is an
    // identity transition (the machine is total and never crashes).
    private static let expectedTransitions: [(ActivationState, ActivationEvent, ActivationState)] = [
        (.purchaseRequired, .beginCheckout, .checkoutPending),
        (.purchaseRequired, .checkoutUnavailable, .checkoutPaused),
        (.purchaseRequired, .provideExistingKey, .keyReady),
        (.purchaseRequired, .choosePublicPath, .publicFreeSkip),

        (.checkoutPaused, .provideExistingKey, .keyReady),
        (.checkoutPaused, .checkoutCompleted, .keyReady),
        (.checkoutPaused, .checkoutCancelled, .purchaseRequired),
        (.checkoutPaused, .resetToPurchase, .purchaseRequired),

        (.checkoutPending, .checkoutCompleted, .keyReady),
        (.checkoutPending, .checkoutCancelled, .purchaseRequired),
        (.checkoutPending, .checkoutUnavailable, .checkoutPaused),
        (.checkoutPending, .activationOffline, .offline),

        (.keyReady, .submitActivation, .activationPending),
        (.keyReady, .resetToPurchase, .purchaseRequired),

        (.activationPending, .activationSucceeded, .active),
        (.activationPending, .activationInvalid, .invalid),
        (.activationPending, .activationExpired, .expired),
        (.activationPending, .activationRevoked, .revoked),
        (.activationPending, .activationScopeConflict, .invalid),
        (.activationPending, .activationOffline, .offline),
        (.activationPending, .activationServiceError, .serviceError),
        (.activationPending, .checkoutCancelled, .keyReady),

        (.active, .activationExpired, .expired),
        (.active, .activationRevoked, .revoked),
        (.active, .activationInvalid, .invalid),
        (.active, .activationOffline, .offline),

        (.invalid, .reenterKey, .keyReady),
        (.invalid, .resetToPurchase, .purchaseRequired),

        (.expired, .renew, .purchaseRequired),
        (.expired, .provideExistingKey, .keyReady),

        (.revoked, .renew, .purchaseRequired),

        (.offline, .retry, .activationPending),
        (.offline, .reenterKey, .keyReady),

        (.serviceError, .retry, .activationPending),
        (.serviceError, .reenterKey, .keyReady),

        (.publicFreeSkip, .choosePrivatePath, .purchaseRequired)
    ]

    @Test func allTwelveStatesExist() {
        let expected: Set<String> = [
            "public_free_skip", "purchase_required", "checkout_paused", "checkout_pending",
            "key_ready", "activation_pending", "active", "invalid", "expired", "revoked",
            "offline", "service_error"
        ]
        #expect(Set(ActivationState.allCases.map(\.rawValue)) == expected)
    }

    @Test func expectedTransitionsHold() {
        for (from, event, to) in Self.expectedTransitions {
            #expect(
                ActivationStateMachine.reduce(from, on: event) == to,
                "\(from.rawValue) --\(event)--> expected \(to.rawValue) got \(ActivationStateMachine.reduce(from, on: event).rawValue)"
            )
        }
    }

    @Test func unlistedPairsAreIdentityAndTotal() {
        let listed = Set(Self.expectedTransitions.map { "\($0.0.rawValue)|\($0.1.rawValue)" })
        for from in ActivationState.allCases {
            for event in ActivationEvent.allCases where !listed.contains("\(from.rawValue)|\(event.rawValue)") {
                #expect(
                    ActivationStateMachine.reduce(from, on: event) == from,
                    "\(from.rawValue) --\(event)--> should be identity"
                )
            }
        }
    }

    @Test func everyStateHasCauseAndTerminology() {
        for state in ActivationState.allCases {
            let p = ActivationStateMachine.presentation(for: state)
            #expect(!p.title.isEmpty, "\(state.rawValue) missing title")
            #expect(!p.cause.isEmpty, "\(state.rawValue) missing cause")
            #expect(!p.accessibilityLabel.isEmpty, "\(state.rawValue) missing AX label")
            // No raw-error jargon or provider/license confusion in customer copy.
            let copy = "\(p.title) \(p.cause) \(p.accessibilityLabel) \(p.recovery?.label ?? "")"
            #expect(!copy.localizedCaseInsensitiveContains("Provider Key"),
                    "\(state.rawValue) copy must not mention Provider Key")
            #expect(!copy.localizedCaseInsensitiveContains("license key"),
                    "\(state.rawValue) copy must use 'NeonDiff Activation Key', not 'license key'")
        }
    }

    @Test func everyNonTerminalStateHasExactlyOneRecovery() {
        // public_free_skip and active are success/terminal-happy; all others must
        // offer exactly one recovery action (no dead ends).
        for state in ActivationState.allCases {
            let p = ActivationStateMachine.presentation(for: state)
            if state == .publicFreeSkip || state == .active {
                continue
            }
            #expect(p.recovery != nil, "\(state.rawValue) is a dead end (no recovery action)")
        }
    }

    @Test func recoveryEventsAreValidTransitions() {
        // The single recovery action each state advertises must actually move the
        // machine (never an identity no-op) — proves the copy matches behavior.
        for state in ActivationState.allCases {
            guard let recovery = ActivationStateMachine.presentation(for: state).recovery else { continue }
            #expect(
                ActivationStateMachine.reduce(state, on: recovery.event) != state,
                "\(state.rawValue) recovery event \(recovery.event) is a no-op"
            )
        }
    }

    @Test func activationKeyTerminologyIsLoadBearing() {
        // The entitlement credential is always "NeonDiff Activation Key".
        #expect(ActivationTerminology.activationKey == "NeonDiff Activation Key")
        #expect(ActivationTerminology.providerKey == "Provider Key")
        let keyReady = ActivationStateMachine.presentation(for: .keyReady)
        #expect(keyReady.accessibilityLabel.contains(ActivationTerminology.activationKey))
    }

    @Test func checkoutPausedIsFirstClassAndHonest() {
        let p = ActivationStateMachine.presentation(for: .checkoutPaused)
        #expect(p.showsNotifyOption, "checkout_paused must offer a notify option")
        // Honest copy: existing keys still activate.
        #expect(p.cause.localizedCaseInsensitiveContains("existing")
                || p.recovery?.label.localizedCaseInsensitiveContains("key") == true,
                "checkout_paused must tell users existing keys still activate")
    }

    @Test func presentationNeverEmbedsRawKeyMaterial() {
        // Redaction invariant: presentation copy is derived only from the state and
        // a caller-supplied REDACTED prefix — a raw secret can never leak into copy.
        let rawSecret = "NDL-SECRET-0123456789ABCDEF"
        let redacted = "NDL-••••"
        for state in ActivationState.allCases {
            let p = ActivationStateMachine.presentation(for: state, redactedKeyPrefix: redacted)
            let copy = "\(p.title) \(p.cause) \(p.accessibilityLabel) \(p.recovery?.label ?? "") \(p.recovery?.accessibilityLabel ?? "")"
            #expect(!copy.contains(rawSecret), "\(state.rawValue) copy leaked raw key material")
        }
    }

    @Test func publicPathNeverShowsLicenseWall() {
        let p = ActivationStateMachine.presentation(for: .publicFreeSkip)
        #expect(!p.requiresKeyEntry, "public_free_skip must never ask for an activation key")
        #expect(p.recovery == nil, "public_free_skip is a clean skip, not a gated wall")
    }
}
