# VibeShare for iOS

The iOS app is the [web client](../distribution) packaged as a native app with
[Capacitor](https://capacitorjs.com): the same pages, search, publishing and credits, with the
client backend running inside the app. Your keys, nodes and settings stay on the device
(back up your identity in *Settings → Identity*).

## Getting the app

The **iOS app** workflow (`.github/workflows/ios.yml`) builds it on every change, on a macOS
runner. Its `vibeshare-ios` artifact holds:

| File | What it is |
|---|---|
| `VibeShare-unsigned.ipa` | The app for iPhone and iPad, not signed. Tools that sign apps with your own Apple ID install it: [AltStore](https://altstore.io), [Sideloadly](https://sideloadly.io). |
| `VibeShare-simulator.app.zip` | A build for the iOS simulator (`xcrun simctl install booted App.app`). |
| `simulator-screenshot.png` | The app as it started in the simulator during the build. |
| `VibeShare.ipa` | A signed build, when the App Store Connect secrets below are set. |

### TestFlight and the App Store

Add these repository secrets (*Settings → Secrets and variables → Actions*):

| Secret | Value |
|---|---|
| `APP_STORE_CONNECT_KEY` | The contents of an App Store Connect API key (`AuthKey_XXXX.p8`) with the **Admin** role, so Xcode can manage the signing certificate and profile. |
| `APP_STORE_CONNECT_KEY_ID` | The key's ID. |
| `APP_STORE_CONNECT_ISSUER_ID` | The issuer ID shown above the keys. |
| `IOS_TEAM_ID` | Your Apple Developer team ID. |

Create the app in App Store Connect with the bundle ID `io.github.mabzgamesstudio.vibeshare`
(or change `appId` in `capacitor.config.json`, `PRODUCT_BUNDLE_IDENTIFIER` in the Xcode project
and `BUNDLE_ID` in the workflow). Then run the workflow by hand with **Upload to TestFlight**
ticked; builds are numbered with the workflow run number.

## Building it yourself

On a Mac with Xcode:

```bash
npm ci && npm --prefix gui ci      # once, in the repository root
cd mobile
npm ci
npm run sync                       # builds the web client and copies it into ios/
npm run open                       # opens the Xcode project; pick a device and Run
```

`scripts/make-icon.ts` draws the app icon and launch screen.

## How it differs from the web client

- **Nodes need HTTPS**, except nodes on your own network (`http://192.168.…`, `http://name.local`).
- **Native content plays once it is downloaded**: without service workers the app cannot stream
  chunk by chunk, so a video starts when its file is complete (every chunk is still checked).
- **The storage service** (earning credits by storing data for providers) needs a client that
  keeps running: the desktop app or `vibeshare client`.
- **Tor**: [Orbot](https://orbot.app) in its VPN mode sends the app's traffic through Tor, so
  nodes do not see your address. Nodes that are only at .onion addresses need the desktop app,
  `vibeshare client` or Tor Browser.
- Players embedded from other platforms are theirs: some refuse to play inside apps and offer
  to open the content on their site instead.
