# Android (TWA) Quickstart — markco.dev

This documents the current Android wrapper setup for `markco.dev`.

## Current app identity

- Package: `dev.markco.app`
- App name: `MarkCo`
- Start URL: `https://markco.dev/?source=pwa`

## Domain association (Digital Asset Links)

Served from production:

- `https://markco.dev/.well-known/assetlinks.json`

Configured relation:

- `delegate_permission/common.handle_all_urls`

## Local signing key (release)

Local-only files (do **not** commit):

- Keystore: `~/.config/markco-android/markco-release.keystore`
- Env (passwords): `~/.config/markco-android/release-keystore.env`

## Generated TWA project

Project scaffold:

- `markco-services/android/twa/`

Main config:

- `markco-services/android/twa/twa-manifest.json`

## Build commands

```bash
# 1) Build unsigned APK + AAB
cd markco-services/android/twa
npx @bubblewrap/cli build --skipSigning

# 2) Sign AAB + APK with release key
source ~/.config/markco-android/release-keystore.env

jarsigner \
  -keystore "$MARKCO_KEYSTORE_PATH" \
  -storepass "$MARKCO_STORE_PASSWORD" \
  -keypass "$MARKCO_KEY_PASSWORD" \
  app/build/outputs/bundle/release/app-release.aab \
  "$MARKCO_KEY_ALIAS"

APKSIGNER=$(find ~/Android/Sdk/build-tools -path '*/apksigner' | sort -V | tail -n1)
"$APKSIGNER" sign \
  --ks "$MARKCO_KEYSTORE_PATH" \
  --ks-key-alias "$MARKCO_KEY_ALIAS" \
  --ks-pass "pass:$MARKCO_STORE_PASSWORD" \
  --key-pass "pass:$MARKCO_KEY_PASSWORD" \
  --out app-release-signed.apk \
  app-release-unsigned-aligned.apk
```

## Output artifacts

Current built artifacts:

- `~/.config/markco-android/builds/markco-v2.aab`
- `~/.config/markco-android/builds/markco-v2.apk`
- Upload key certificate (PEM): `~/.config/markco-android/builds/markco-upload-key-cert.pem`

Upload to Play Console:

- Use the **AAB** (`markco-v2.aab`)

## Play Console checklist

1. Create app `MarkCo` with package `dev.markco.app`
2. Upload `markco-v2.aab`
3. Complete store listing (icon/screenshots/description)
   - Privacy policy URL: `https://markco.dev/privacy`
   - Terms URL (optional): `https://markco.dev/terms`
4. Complete Data safety + content rating
5. Internal testing track first
6. Promote to production
