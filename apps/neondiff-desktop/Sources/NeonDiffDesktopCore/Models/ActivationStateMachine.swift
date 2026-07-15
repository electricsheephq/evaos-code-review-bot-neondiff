import Foundation

// Issue #612 — the native purchase-to-activation state machine.
//
// Pure, UI-free, and exhaustively testable. The 12 states below are the
// authoritative CLOSED set from the customer-journey UX blueprint stage 6 and
// the issue acceptance criteria. Every state names its cause and offers exactly
// one recovery action (no dead ends), and the state is persistable as its raw
// value so onboarding resumes exactly where the user left it across relaunch,
// cancellation, or network loss (AC6).
//
// Authoritative policy (epic layer 3, owner-ratified): public repositories are
// free and require NO NeonDiff Activation Key; private/commercial repositories
// require an active entitlement. The entitlement credential is always
// "NeonDiff Activation Key" and is never confused with the model "Provider Key".

/// The naming that is load-bearing across every activation surface, including
/// accessibility labels.
public enum ActivationTerminology {
    /// The product entitlement credential.
    public static let activationKey = "NeonDiff Activation Key"
    /// The model provider credential — deliberately distinct.
    public static let providerKey = "Provider Key"
}

public enum ActivationState: String, CaseIterable, Codable, Sendable, Hashable {
    /// Public/free path — reaches provider setup with NO license UI ever shown.
    case publicFreeSkip = "public_free_skip"
    /// Private repo selected; entitlement required before provider calls.
    case purchaseRequired = "purchase_required"
    /// Live production reality today: checkout is paused. Honest, first-class.
    case checkoutPaused = "checkout_paused"
    /// Approved checkout opened; awaiting completion.
    case checkoutPending = "checkout_pending"
    /// A NeonDiff Activation Key is available (pasted or returned) but not activated.
    case keyReady = "key_ready"
    /// Activation call in flight against the license service.
    case activationPending = "activation_pending"
    /// Entitlement is active — private repos unlocked.
    case active
    /// The key was not recognized (or could not bind to this machine).
    case invalid
    /// The entitlement has expired.
    case expired
    /// The entitlement was revoked.
    case revoked
    /// The activation could not reach the service (timeout/network).
    case offline
    /// The service returned a retryable failure.
    case serviceError = "service_error"
}

public enum ActivationEvent: String, CaseIterable, Sendable, Hashable {
    case choosePublicPath
    case choosePrivatePath
    case beginCheckout
    case checkoutUnavailable
    case checkoutCompleted
    case checkoutCancelled
    case provideExistingKey
    case submitActivation
    case activationSucceeded
    case activationInvalid
    case activationExpired
    case activationRevoked
    /// Seat exhausted / single-activation replay conflict (entitlement
    /// `scope_mismatch`). Folds into `invalid` for the user (key cannot activate
    /// here); the distinct cause is surfaced by the client detail, not a state.
    case activationScopeConflict
    case activationOffline
    case activationServiceError
    case retry
    case reenterKey
    case renew
    case resetToPurchase
}

/// A single recovery action a state advertises — the one path forward.
public struct ActivationRecovery: Equatable, Sendable {
    public let label: String
    public let event: ActivationEvent
    public let accessibilityLabel: String

    public init(label: String, event: ActivationEvent, accessibilityLabel: String) {
        self.label = label
        self.event = event
        self.accessibilityLabel = accessibilityLabel
    }
}

/// UI-agnostic presentation for a state: cause copy, the one recovery action,
/// and the accessibility label. Copy is derived only from the state and a
/// caller-supplied REDACTED key prefix, so raw key material can never leak here.
public struct ActivationStatePresentation: Equatable, Sendable {
    public let state: ActivationState
    public let title: String
    public let cause: String
    public let recovery: ActivationRecovery?
    public let accessibilityLabel: String
    public let isSuccess: Bool
    public let requiresKeyEntry: Bool
    public let showsNotifyOption: Bool
}

public enum ActivationStateMachine {
    /// The private branch is entered at `purchase_required`; the public branch is
    /// entered directly at `public_free_skip` by the onboarding flow.
    public static let initialState: ActivationState = .purchaseRequired

    /// Total, pure transition function. Any (state, event) pair without a defined
    /// transition is an identity no-op — the machine never crashes or dead-ends.
    public static func reduce(_ state: ActivationState, on event: ActivationEvent) -> ActivationState {
        switch (state, event) {
        case (.purchaseRequired, .beginCheckout): return .checkoutPending
        case (.purchaseRequired, .checkoutUnavailable): return .checkoutPaused
        case (.purchaseRequired, .provideExistingKey): return .keyReady
        case (.purchaseRequired, .choosePublicPath): return .publicFreeSkip

        case (.checkoutPaused, .provideExistingKey): return .keyReady
        case (.checkoutPaused, .checkoutCompleted): return .keyReady
        case (.checkoutPaused, .checkoutCancelled): return .purchaseRequired
        case (.checkoutPaused, .resetToPurchase): return .purchaseRequired

        case (.checkoutPending, .checkoutCompleted): return .keyReady
        case (.checkoutPending, .checkoutCancelled): return .purchaseRequired
        case (.checkoutPending, .checkoutUnavailable): return .checkoutPaused
        case (.checkoutPending, .activationOffline): return .offline

        case (.keyReady, .submitActivation): return .activationPending
        case (.keyReady, .resetToPurchase): return .purchaseRequired

        case (.activationPending, .activationSucceeded): return .active
        case (.activationPending, .activationInvalid): return .invalid
        case (.activationPending, .activationExpired): return .expired
        case (.activationPending, .activationRevoked): return .revoked
        case (.activationPending, .activationScopeConflict): return .invalid
        case (.activationPending, .activationOffline): return .offline
        case (.activationPending, .activationServiceError): return .serviceError
        case (.activationPending, .checkoutCancelled): return .keyReady
        // A stored key that has gone missing mid-activation returns to key entry
        // rather than leaving the user stuck on the Activating state.
        case (.activationPending, .reenterKey): return .keyReady

        case (.active, .activationExpired): return .expired
        case (.active, .activationRevoked): return .revoked
        case (.active, .activationInvalid): return .invalid
        case (.active, .activationOffline): return .offline

        case (.invalid, .reenterKey): return .keyReady
        case (.invalid, .resetToPurchase): return .purchaseRequired

        case (.expired, .renew): return .purchaseRequired
        case (.expired, .provideExistingKey): return .keyReady

        case (.revoked, .renew): return .purchaseRequired

        case (.offline, .retry): return .activationPending
        case (.offline, .reenterKey): return .keyReady

        case (.serviceError, .retry): return .activationPending
        case (.serviceError, .reenterKey): return .keyReady

        case (.publicFreeSkip, .choosePrivatePath): return .purchaseRequired

        default: return state
        }
    }

    public static func presentation(
        for state: ActivationState,
        redactedKeyPrefix: String? = nil
    ) -> ActivationStatePresentation {
        let keyTerm = ActivationTerminology.activationKey
        switch state {
        case .publicFreeSkip:
            return ActivationStatePresentation(
                state: state,
                title: "Public repositories are free",
                cause: "You chose public repositories. Public review is free — no \(keyTerm) is needed. Private repositories are paid and can be activated later.",
                recovery: nil,
                accessibilityLabel: "Public repositories are free. No \(keyTerm) required.",
                isSuccess: true,
                requiresKeyEntry: false,
                showsNotifyOption: false
            )

        case .purchaseRequired:
            return ActivationStatePresentation(
                state: state,
                title: "Private repositories need activation",
                cause: "Private repository review requires an active \(keyTerm). Get one through checkout, or paste a key you already have.",
                recovery: ActivationRecovery(
                    label: "Get a \(keyTerm)",
                    event: .beginCheckout,
                    accessibilityLabel: "Open checkout to get a \(keyTerm)"
                ),
                accessibilityLabel: "Private repositories require an active \(keyTerm).",
                isSuccess: false,
                requiresKeyEntry: false,
                showsNotifyOption: false
            )

        case .checkoutPaused:
            return ActivationStatePresentation(
                state: state,
                title: "Checkout is paused",
                cause: "New checkout is paused right now. Existing keys still activate — paste your \(keyTerm) below, or ask to be notified when checkout reopens.",
                recovery: ActivationRecovery(
                    label: "Paste your \(keyTerm)",
                    event: .provideExistingKey,
                    accessibilityLabel: "Paste an existing \(keyTerm) to activate"
                ),
                accessibilityLabel: "Checkout is paused. Existing \(keyTerm)s still activate.",
                isSuccess: false,
                requiresKeyEntry: true,
                showsNotifyOption: true
            )

        case .checkoutPending:
            return ActivationStatePresentation(
                state: state,
                title: "Finishing checkout",
                cause: "Complete checkout in your browser. When it finishes you'll receive a \(keyTerm) to activate here.",
                recovery: ActivationRecovery(
                    label: "Cancel checkout",
                    event: .checkoutCancelled,
                    accessibilityLabel: "Cancel checkout and return to activation options"
                ),
                accessibilityLabel: "Waiting for checkout to finish and return a \(keyTerm).",
                isSuccess: false,
                requiresKeyEntry: false,
                showsNotifyOption: false
            )

        case .keyReady:
            let prefixNote = redactedKeyPrefix.map { " (\($0))" } ?? ""
            return ActivationStatePresentation(
                state: state,
                title: "Activate your \(keyTerm)",
                cause: "Your \(keyTerm)\(prefixNote) is ready. Activate it to unlock private repository review.",
                recovery: ActivationRecovery(
                    label: "Activate",
                    event: .submitActivation,
                    accessibilityLabel: "Activate the \(keyTerm)"
                ),
                accessibilityLabel: "\(keyTerm)\(prefixNote) is ready to activate.",
                isSuccess: false,
                requiresKeyEntry: true,
                showsNotifyOption: false
            )

        case .activationPending:
            return ActivationStatePresentation(
                state: state,
                title: "Activating",
                cause: "Checking your \(keyTerm) with the activation service. This only takes a moment.",
                recovery: ActivationRecovery(
                    label: "Cancel",
                    event: .checkoutCancelled,
                    accessibilityLabel: "Cancel activation and return to the key"
                ),
                accessibilityLabel: "Activating your \(keyTerm).",
                isSuccess: false,
                requiresKeyEntry: false,
                showsNotifyOption: false
            )

        case .active:
            return ActivationStatePresentation(
                state: state,
                title: "Activated",
                cause: "Your \(keyTerm) is active. Private repository review is unlocked.",
                recovery: nil,
                accessibilityLabel: "\(keyTerm) is active. Private repositories unlocked.",
                isSuccess: true,
                requiresKeyEntry: false,
                showsNotifyOption: false
            )

        case .invalid:
            return ActivationStatePresentation(
                state: state,
                title: "That key didn't work",
                cause: "This \(keyTerm) wasn't recognized for this machine. Check for a typo and enter it again, or use a different key.",
                recovery: ActivationRecovery(
                    label: "Enter a \(keyTerm)",
                    event: .reenterKey,
                    accessibilityLabel: "Enter a \(keyTerm) again"
                ),
                accessibilityLabel: "The \(keyTerm) was not recognized.",
                isSuccess: false,
                requiresKeyEntry: true,
                showsNotifyOption: false
            )

        case .expired:
            return ActivationStatePresentation(
                state: state,
                title: "Your entitlement expired",
                cause: "This \(keyTerm) has expired. Renew to keep reviewing private repositories, or paste a renewed key.",
                recovery: ActivationRecovery(
                    label: "Renew",
                    event: .renew,
                    accessibilityLabel: "Renew your entitlement"
                ),
                accessibilityLabel: "The \(keyTerm) has expired.",
                isSuccess: false,
                requiresKeyEntry: false,
                showsNotifyOption: false
            )

        case .revoked:
            return ActivationStatePresentation(
                state: state,
                title: "This key was revoked",
                cause: "This \(keyTerm) was revoked. Get a new one to continue, or contact support if this is unexpected.",
                recovery: ActivationRecovery(
                    label: "Get a new \(keyTerm)",
                    event: .renew,
                    accessibilityLabel: "Get a new \(keyTerm)"
                ),
                accessibilityLabel: "The \(keyTerm) was revoked.",
                isSuccess: false,
                requiresKeyEntry: false,
                showsNotifyOption: false
            )

        case .offline:
            return ActivationStatePresentation(
                state: state,
                title: "Couldn't reach activation",
                cause: "We couldn't reach the activation service — it looks like you're offline. Check your connection and try again.",
                recovery: ActivationRecovery(
                    label: "Try again",
                    event: .retry,
                    accessibilityLabel: "Retry activation"
                ),
                accessibilityLabel: "Activation could not reach the service. You appear to be offline.",
                isSuccess: false,
                requiresKeyEntry: false,
                showsNotifyOption: false
            )

        case .serviceError:
            return ActivationStatePresentation(
                state: state,
                title: "Activation service hiccup",
                cause: "The activation service returned a temporary error. Nothing is wrong with your \(keyTerm) — try again in a moment.",
                recovery: ActivationRecovery(
                    label: "Try again",
                    event: .retry,
                    accessibilityLabel: "Retry activation"
                ),
                accessibilityLabel: "The activation service returned a temporary error.",
                isSuccess: false,
                requiresKeyEntry: false,
                showsNotifyOption: false
            )
        }
    }
}
