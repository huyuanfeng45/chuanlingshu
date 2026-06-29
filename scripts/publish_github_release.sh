#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="$(node -p "require('./package.json').version")"
TAG="v${VERSION}"
REPO="${GITHUB_REPOSITORY:-huyuanfeng45/chuanlingshu}"
LOCAL_DMG_PATH="dist/传令书-${VERSION}-arm64-local-signed.dmg"
UPLOAD_DMG_PATH="dist/chuanlingshu-${VERSION}-arm64-local-signed.dmg"

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI gh 未安装，请先安装 gh。"
  exit 1
fi

gh auth status >/dev/null

if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  npm run dist:local
fi

if [[ ! -f "$LOCAL_DMG_PATH" ]]; then
  echo "找不到 DMG：$LOCAL_DMG_PATH"
  exit 1
fi

cp "$LOCAL_DMG_PATH" "$UPLOAD_DMG_PATH"

if ! git rev-parse "$TAG" >/dev/null 2>&1; then
  git tag "$TAG"
fi

git push origin "$TAG"

if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  gh release upload "$TAG" "$UPLOAD_DMG_PATH" --repo "$REPO" --clobber
else
  gh release create "$TAG" "$UPLOAD_DMG_PATH" \
    --repo "$REPO" \
    --title "传令书 ${TAG}" \
    --notes "传令书 ${TAG} 发布包。更新内容请查看应用内「版本更新」或 GitHub Releases。"
fi

echo "已发布到 GitHub Releases：https://github.com/${REPO}/releases/tag/${TAG}"
