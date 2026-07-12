package com.salezica.ivy

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * Aggregates Ivy's native modules behind a single ReactPackage.
 *
 * React Native core autolinking registers exactly one package per library
 * (see react-native.config.js), so this delegates to the per-feature packages.
 */
class IvyPackage : ReactPackage {
    private val packages = listOf(
        AudioSlicerPackage(),
        AudioMetadataPackage(),
        FileCopierPackage(),
        ChapterReaderPackage(),
    )

    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
        return packages.flatMap { it.createNativeModules(reactContext) }
    }

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
        return packages.flatMap { it.createViewManagers(reactContext) }
    }
}
