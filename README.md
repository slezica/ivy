# Audio Player React Native

A React Native Expo app for podcast and audiobook playback with library management, clips/bookmarks with notes, and GPU-accelerated timeline UI. Files are automatically copied to app-owned storage to prevent content URI invalidation issues, with resume position tracking and auto-play support.

## Development Setup

### Prerequisites

- Node.js
- **Android**: Android Studio with SDK installed, `ANDROID_HOME` environment variable set
- **iOS**: Xcode (macOS only)

### Install Dependencies

```bash
npm install
```

### Development Client Setup

This project uses Expo Dev Client (custom development build) instead of Expo Go to support native file streaming and avoid memory issues with large audio files.

#### 1. Install Dev Client Package

```bash
npx expo install expo-dev-client
```

#### 2. Generate Native Projects

```bash
# Android only
npx expo prebuild --platform android

# iOS only (macOS required)
npx expo prebuild --platform ios

# Both platforms
npx expo prebuild
```

#### 3. Build and Install Development Client (MacOS)

**Android:**

```bash
# Find Android Studio's bundled JDK
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"

# Build APK
(cd android && ./gradlew assembleDebug)

# Install on device (connect via USB or use emulator)
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

**iOS:**

```bash
# Build and run on simulator
npx expo run:ios

# Or build for device
# Open ios/audioplayerreactnative.xcworkspace in Xcode
# Select your device and build
```

#### 4. Start Development Server

```bash
npx expo start --dev-client
```

Open the installed app on your device - it will connect to the Metro bundler automatically.

### Rebuilding After Native Changes

When you add new native dependencies or modify native code:

```bash
# Android
cd android && ./gradlew clean && ./gradlew assembleDebug
adb install -r android/app/build/outputs/apk/debug/app-debug.apk

# iOS
cd ios && xcodebuild clean
npx expo run:ios
```

## Production Builds

### Local Production Builds

**Android APK:**

```bash
cd android && ./gradlew assembleRelease
# Output: android/app/build/outputs/apk/release/app-release.apk
```

**Android AAB (for Google Play):**

```bash
cd android && ./gradlew bundleRelease
# Output: android/app/build/outputs/bundle/release/app-release.aab
```

**iOS (macOS only):**

```bash
# Open Xcode
open ios/audioplayerreactnative.xcworkspace

# Product > Archive
# Follow Xcode's distribution workflow
```

### Cloud Builds with EAS

For easier builds without local setup:

```bash
# Install EAS CLI
npm install -g eas-cli

# Configure project
eas build:configure

# Build for Android
eas build --platform android

# Build for iOS
eas build --platform ios

# Build for both
eas build --platform all
```

## Tech Stack

- React Native 0.81.5
- Expo SDK 54
- Zustand (state management)
- Expo Router (file-based navigation)
- expo-audio (playback with 100ms polling)
- expo-sqlite (persistence)
- @shopify/react-native-skia (GPU timeline rendering)

## Key Features

- **File Storage**: Copies external files to app-owned storage with chunked streaming to avoid OOM
- **Resume Position**: Automatically saves and restores playback position
- **Clips/Bookmarks**: Create time-based clips with notes
- **GPU Timeline**: Hardware-accelerated timeline with center-fixed playhead
- **Auto-play**: Resumes from last position on file load

## Development Tools

**Reset App Data:**
Tap the 🔧 Reset button in the Library screen to clear all data (files, clips, sessions).

## License

MIT
