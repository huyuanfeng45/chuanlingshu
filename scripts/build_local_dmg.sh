#!/usr/bin/env bash
set -euo pipefail

APP_NAME="$(node -p "require('./package.json').build.productName")"
VERSION="$(node -p "require('./package.json').version")"
APP_PATH="dist/mac-arm64/${APP_NAME}.app"

node scripts/create_dmg_background.cjs

rm -rf dist
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dmg

IDENTITY="${CODESIGN_IDENTITY:-}"
if [[ -z "${IDENTITY}" ]]; then
  IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | awk -F '"' '/Developer ID Application|Apple Development|Mac Developer/ { print $2; exit }')"
fi

SIGN_KIND="signed"
if [[ -z "${IDENTITY}" ]]; then
  IDENTITY="-"
  SIGN_KIND="adhoc"
  echo "warning: no stable code signing identity found; falling back to ad-hoc signing."
  echo "warning: macOS Accessibility permission may need to be granted again after updates."
fi

echo "Signing ${APP_PATH} with: ${IDENTITY}"
codesign --force --deep --sign "${IDENTITY}" "${APP_PATH}"
codesign --verify --deep --strict --verbose=2 "${APP_PATH}"
codesign -dv --verbose=4 "${APP_PATH}" 2>&1 | sed -n '1,28p'

DMG_PATH="dist/${APP_NAME}-${VERSION}-arm64-local-${SIGN_KIND}.dmg"
RW_DMG_PATH="dist/${APP_NAME}-${VERSION}-arm64-local-${SIGN_KIND}-rw.dmg"
MOUNT_DIR="/Volumes/${APP_NAME}"
rm -rf dist/dmg-root
mkdir -p dist/dmg-root/.background
ditto "${APP_PATH}" "dist/dmg-root/${APP_NAME}.app"
ditto "build/dmg-background.png" "dist/dmg-root/.background/dmg-background.png"
ln -s /Applications dist/dmg-root/Applications

cleanup_mount() {
  hdiutil detach "${MOUNT_DIR}" -quiet >/dev/null 2>&1 || true
}
trap cleanup_mount EXIT

rm -f "${DMG_PATH}" "${RW_DMG_PATH}"
for volume in /Volumes/"${APP_NAME}"*; do
  [[ -e "${volume}" ]] || continue
  hdiutil detach "${volume}" -quiet >/dev/null 2>&1 || true
done
rmdir "${MOUNT_DIR}" >/dev/null 2>&1 || true
hdiutil create -volname "${APP_NAME}" -srcfolder dist/dmg-root -ov -format UDRW -fs HFS+ "${RW_DMG_PATH}"
hdiutil attach "${RW_DMG_PATH}" -mountpoint "${MOUNT_DIR}" -nobrowse -readwrite

osascript <<OSA
tell application "Finder"
  tell disk "${APP_NAME}"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set bounds of container window to {100, 100, 760, 520}
    set theOptions to icon view options of container window
    set arrangement of theOptions to not arranged
    set icon size of theOptions to 96
    set background picture of theOptions to alias "${APP_NAME}:.background:dmg-background.png"
    set position of item "${APP_NAME}.app" of container window to {178, 214}
    set position of item "Applications" of container window to {488, 214}
    update without registering applications
    delay 1
    close
  end tell
end tell
OSA

SetFile -a V "${MOUNT_DIR}/.background" || true
sync
hdiutil detach "${MOUNT_DIR}"
trap - EXIT
rmdir "${MOUNT_DIR}" >/dev/null 2>&1 || true
hdiutil convert "${RW_DMG_PATH}" -format UDZO -imagekey zlib-level=9 -o "${DMG_PATH}"
rm -f "${RW_DMG_PATH}"
hdiutil verify "${DMG_PATH}"
echo "created: ${DMG_PATH}"
