package com.salezica.ivy

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/**
 * Aggregates Ivy's native modules behind a single lazy ReactPackage.
 *
 * React Native core autolinking registers exactly one package per library
 * (see react-native.config.js), so every Ivy module is declared here. Keys
 * must match each module's getName() — that's what getModule() is called with.
 */
class IvyPackage : BaseReactPackage() {
    private val constructors: Map<String, (ReactApplicationContext) -> NativeModule> = mapOf(
        "AudioSlicer" to ::AudioSlicerModule,
        "AudioMetadataModule" to ::AudioMetadataModule,
        "FileCopier" to ::FileCopierModule,
        "FFmetadataReader" to ::FFmetadataReaderModule,
        "BuildInfo" to ::BuildInfoModule,
    )

    override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
        constructors[name]?.invoke(reactContext)

    override fun getReactModuleInfoProvider() = ReactModuleInfoProvider {
        constructors.keys.associateWith { name ->
            ReactModuleInfo(name, name, false, false, false, false)
        }
    }
}
