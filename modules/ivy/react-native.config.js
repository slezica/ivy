// React Native core autolinking config for Ivy's local native modules.
//
// This package is discovered by expo-modules-autolinking's react-native-config
// resolution through the default local modules directory (`modules/`). Core
// autolinking registers exactly ONE ReactPackage per library, and it derives
// the import path from the Gradle namespace — which differs from the Kotlin
// source package here (`native` is not usable as a package segment, the code
// stays in `com.salezica.ivy`). Both are overridden explicitly: IvyPackage
// aggregates the four per-feature packages.
module.exports = {
  dependency: {
    platforms: {
      android: {
        packageImportPath: 'import com.salezica.ivy.IvyPackage;',
        packageInstance: 'new IvyPackage()',
      },
    },
  },
}
