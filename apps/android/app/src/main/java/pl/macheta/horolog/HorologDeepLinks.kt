package pl.macheta.horolog

import android.net.Uri

object HorologDeepLinks {
    const val PLANNER = "horolog://planner"

    fun time(intentId: String): String {
        if (intentId.isBlank()) return PLANNER

        return Uri.Builder()
            .scheme("horolog")
            .authority("time")
            .appendQueryParameter("focus", intentId)
            .build()
            .toString()
    }
}
