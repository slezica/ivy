package com.salezica.ivy

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule

/**
 * Exposes build information to JS as constants.
 *
 * - variant: the app-level `ivy_build_variant` string resource, set per
 *   buildType by plugins/withIvyBuildTypes.js ("debug" / "maestro" /
 *   "production"). Missing resource reads as "production" — the safe default.
 * - versionName: from PackageInfo (derived from package.json by
 *   plugins/withIvyVersionName.js).
 * - buildDate: the `ivy_build_date` string resource (yyyy-MM-dd), stamped at
 *   build time by plugins/withIvyVersionName.js. Missing resource reads as "".
 */
class BuildInfoModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {

    override fun getName() = "BuildInfo"

    override fun getConstants(): Map<String, Any> {
        val versionName = context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: ""
        return mapOf(
            "variant" to stringResource("ivy_build_variant", "production"),
            "versionName" to versionName,
            "buildDate" to stringResource("ivy_build_date", ""),
        )
    }

    private fun stringResource(name: String, fallback: String): String {
        val id = context.resources.getIdentifier(name, "string", context.packageName)
        return if (id != 0) context.getString(id) else fallback
    }
}
