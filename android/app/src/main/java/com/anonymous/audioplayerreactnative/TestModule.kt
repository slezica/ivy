package com.anonymous.audioplayerreactnative

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise

class TestModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String {
        return "TestModule"
    }

    @ReactMethod
    fun getString(promise: Promise) {
        try {
            promise.resolve("Hello from native Android!")
        } catch (e: Exception) {
            promise.reject("ERROR", e.message, e)
        }
    }
}
