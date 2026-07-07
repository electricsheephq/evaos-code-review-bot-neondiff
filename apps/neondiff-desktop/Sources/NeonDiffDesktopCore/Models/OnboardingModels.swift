import Foundation

public enum OnboardingMode: String, CaseIterable, Identifiable, Hashable {
    case publicReposOnly
    case privateRepos

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .publicReposOnly: "Public Repos"
        case .privateRepos: "Private Repos"
        }
    }
}

public enum OnboardingStep: String, CaseIterable, Identifiable, Hashable {
    case welcome
    case provider
    case daemon
    case license
    case done

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .welcome: "Welcome"
        case .provider: "Provider"
        case .daemon: "Daemon"
        case .license: "License"
        case .done: "Done"
        }
    }

    public var systemImage: String {
        switch self {
        case .welcome: "sparkles"
        case .provider: "cpu"
        case .daemon: "bolt.horizontal.circle"
        case .license: "key"
        case .done: "checkmark.seal"
        }
    }
}

public enum OnboardingLicenseActivation: String, Hashable {
    case notStarted
    case servicePending
    case activated
}

public struct OnboardingFlow: Equatable {
    public var currentStep: OnboardingStep
    public var mode: OnboardingMode
    public var providerKeyStored: Bool
    public var daemonBootstrapChecked: Bool
    public var licenseActivation: OnboardingLicenseActivation

    public init(
        currentStep: OnboardingStep = .welcome,
        mode: OnboardingMode = .publicReposOnly,
        providerKeyStored: Bool = false,
        daemonBootstrapChecked: Bool = false,
        licenseActivation: OnboardingLicenseActivation = .servicePending
    ) {
        self.currentStep = currentStep
        self.mode = mode
        self.providerKeyStored = providerKeyStored
        self.daemonBootstrapChecked = daemonBootstrapChecked
        self.licenseActivation = licenseActivation
    }

    public var canGoBack: Bool {
        currentStep != .welcome
    }

    public var canAdvance: Bool {
        switch currentStep {
        case .welcome:
            return true
        case .provider:
            return providerKeyStored
        case .daemon:
            return daemonBootstrapChecked
        case .license:
            return mode == .publicReposOnly || licenseActivation == .activated
        case .done:
            return true
        }
    }

    public var nextActionTitle: String {
        switch currentStep {
        case .done:
            return "Finish"
        case .license where mode == .publicReposOnly:
            return "Continue Public Setup"
        default:
            return "Continue"
        }
    }

    public mutating func advance() {
        guard canAdvance else { return }
        switch currentStep {
        case .welcome:
            currentStep = .provider
        case .provider:
            currentStep = .daemon
        case .daemon:
            currentStep = .license
        case .license:
            currentStep = .done
        case .done:
            break
        }
    }

    public mutating func goBack() {
        switch currentStep {
        case .welcome:
            break
        case .provider:
            currentStep = .welcome
        case .daemon:
            currentStep = .provider
        case .license:
            currentStep = .daemon
        case .done:
            currentStep = .license
        }
    }
}
