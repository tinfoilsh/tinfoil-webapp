#!/bin/bash

# Update script for Plausible Analytics
# Downloads the latest version and shows what changed

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "🔄 Updating Plausible Analytics..."
echo ""

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

name="Plausible Analytics"
url="https://plausible.io/js/script.js"
file="plausible.js"

# plausible.js carries local privacy edits that the upstream script does not
# have. They must be re-applied by hand after every update, and
# tests/pages/plausible-analytics.test.ts will fail until they are:
#   - x(): suppress all events on /, /newchat, /chat*, /share*, /project/*/chat*
#   - b.u and l: report location.origin + location.pathname, never href
#   - k(): reduce document.referrer to origin + pathname before sending as b.r
# The stock script is downloaded to plausible.upstream.js so the edits can be
# ported with a diff instead of overwriting the customized file.
download_target="plausible.upstream.js"

# Download to a temp file and move into place only on success, so a failed
# run never destroys an upstream copy that is still being ported.
tmp_download="$(mktemp "${download_target}.XXXXXX")"
if curl -f -L --silent --show-error -o "$tmp_download" "$url"; then
    mv "$tmp_download" "$download_target"
    new_size=$(wc -c < "$download_target")
    echo -e "${GREEN}✓${NC} $name upstream downloaded to ${download_target} (${new_size} bytes)"
else
    echo "❌ Failed to download $name"
    rm -f "$tmp_download"
    exit 1
fi

echo ""
echo "Next steps:"
echo "1. Port the upstream changes into ${file} by hand:"
echo "     diff ${download_target} ${file}"
echo "   keeping the local privacy edits listed at the top of this script."
echo "2. Delete ${download_target} once ported."
echo "3. Recompute the SRI hash and update src/pages/_app.tsx:"
echo "     openssl dgst -sha384 -binary ${file} | openssl base64 -A"
echo "4. Run: npx vitest run tests/pages/plausible-analytics.test.ts"
echo -e "   ${YELLOW}It fails until the privacy edits and SRI hash are both in place.${NC}"
