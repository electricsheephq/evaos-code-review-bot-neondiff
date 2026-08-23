# Native Desktop customer adoption

This is the customer path for an accepted NeonDiff Desktop release. It does not
cover the legacy CLI worker installer or source-checkout operation.

1. Install only the immutable app bytes named by the release. The acceptance
   packet must bind the source SHA and signed tag to the archive and bundle-tree
   digests, Team ID, bundle/version/build identities, codesign and hardened
   runtime results, notarization and staple results, Gatekeeper assessment,
   manifest digest, feed digest, and Sparkle EdDSA signature.
2. Link the account and select the bot. The app-owned config is
   `~/Library/Application Support/NeonDiffDesktop/Accounts/<account>/Bots/<bot>/config.local.json`;
   its review database is `state/reviews.sqlite`. Never copy either to a
   release checkout.
3. In Overview, use **Preview Start**, then **Install & Start** (or
   **Start/Restart**), and verify the displayed status. The signed app owns the
   selected launchd label and sealed helper; secrets remain in Keychain.
4. Use **Check for Updates**. Adopt an update only when the downloaded bytes
   match the accepted release packet and the installed codesign, notary,
   Gatekeeper, manifest, feed, and worker-identity receipts all agree.
5. The current Sparkle appcast cannot downgrade an installed build. Rollback is
   unavailable until the release owner supplies a separate proven recovery path
   using an accepted immutable signed/notarized last-known-good artifact. Its
   receipt must prove the same account, bot, config, database, allowlist,
   Keychain identity, selected label, and one wrapper/helper worker pair
   survived, then prove a re-update. Do not use **Check for Updates** to roll
   back.

Preview, start, status, update, and rollback fail closed on a missing account,
bot, config, Keychain item, accepted artifact identity, or safe rollback target.
