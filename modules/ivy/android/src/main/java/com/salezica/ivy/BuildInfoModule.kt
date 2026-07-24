package com.salezica.ivy

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule

/**
 * Exposes the build-variant signal to JS as a constant.
 *
 * Reads the app-level `ivy_build_variant` string resource, set per buildType
 * by plugins/withIvyBuildTypes.js ("debug" / "maestro" / "production").
 * Missing resource reads as "production" — the safe default.
 */
class BuildInfoModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {

    override fun getName() = "BuildInfo"

    override fun getConstants(): Map<String, Any> {
        val id = context.resources.getIdentifier("ivy_build_variant", "string", context.packageName)
        val variant = if (id != 0) context.getString(id) else "production"
        return mapOf("variant" to variant)
    }
}
