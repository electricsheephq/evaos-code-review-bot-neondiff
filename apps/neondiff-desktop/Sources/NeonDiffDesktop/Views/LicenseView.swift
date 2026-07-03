import SwiftUI

struct LicenseView: View {
    @ObservedObject var model: NeonDiffDesktopModel

    var body: some View {
        Form {
            Section("License") {
                SecureField("License Key", text: $model.pendingLicenseKey)
                HStack {
                    Button("Store License") { model.storeLicenseKey() }
                    Label(model.license.keyStored ? "Stored locally" : "No key stored", systemImage: model.license.keyStored ? "checkmark.seal" : "key")
                        .foregroundStyle(model.license.keyStored ? .green : .secondary)
                }
                LabeledContent("Entitlement", value: model.license.entitlement)
                LabeledContent("Update Channel", value: model.license.updateChannel)
            }

            Section("Boundary") {
                Text("This MVP stores a fake/local license key only. Activation, signed updater behavior, and downloadable app readiness remain separate release work.")
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .padding(20)
    }
}
