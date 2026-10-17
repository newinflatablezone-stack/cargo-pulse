# Business account order isolation

Business accounts can read only assigned orders and their events, images, factories,
shipments, shipment events, and order issues. The server applies ownership before
projection, filtering and pagination, including home snapshots and RPC fallbacks.

An explicit business_id / business_user_id takes priority. Conflicting IDs are
invisible to business users. Legacy names resolve only to a unique active business
profile using trusted name fields and the established Ella/Sherry/Demi/Rayna email
mapping. Email prefixes alone never grant access. Unresolved legacy ownership stays
with staff for review. Staff form changes bind the selected name to its account ID.

Issue history follows the current order owner after reassignment. Attachments are
signed per user and also require that user's active session on every download;
switching accounts, logout and reassignment invalidate access. Public customer
tracking remains a separate limited customer lookup; it does not expose staff data.

Old browser order snapshots are removed and no longer persisted. Previously
viewed or downloaded data cannot be recalled from a user's device.

## Required production configuration

The nginx /uploads/ alias must not serve the physical private orders subdirectory.
The new deployer runs isolate-order-uploads.py before publishing code. On servers
with a previously installed deployer, refresh that deployer once from the existing
checkout by running on the Tencent server:

    sudo bash /opt/cargo-pulse/deploy/tencent/repair-deployer.sh

This installs the current deployment script and applies the privacy guard even
when the application version is already up to date. The helper backs up modified
nginx files in a private /tmp/cargo-order-privacy-backup-* directory, validates
nginx configuration, then reloads it. Failure restores the edited files.
Shared /uploads/resources/ images remain available; only private /uploads/orders/
is blocked. Confirm with a read-only request:

    curl -I https://kis.net/uploads/orders/__order_privacy_probe__

Expected: HTTP 404 and X-Cargo-Pulse-Order-Privacy: scoped.
Do not describe the privacy rollout as complete until the static route is blocked.
