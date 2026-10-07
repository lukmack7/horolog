package pl.macheta.horolog

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build

object NotificationChannels {
    const val SCHEDULE = "horolog_schedule"
    const val DEADLINES = "horolog_deadlines"
    const val DAILY_REVIEW = "horolog_daily_review"

    fun create(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannels(
            listOf(
                NotificationChannel(
                    SCHEDULE,
                    "Plan dnia",
                    NotificationManager.IMPORTANCE_DEFAULT,
                ).apply {
                    description = "Przypomnienia przed rozpoczęciem zadania lub spotkania."
                },
                NotificationChannel(
                    DEADLINES,
                    "Deadline",
                    NotificationManager.IMPORTANCE_HIGH,
                ).apply {
                    description = "Ostrzeżenia o zbliżających się maksymalnych deadline."
                },
                NotificationChannel(
                    DAILY_REVIEW,
                    "Koniec dnia",
                    NotificationManager.IMPORTANCE_DEFAULT,
                ).apply {
                    description = "Podsumowanie dnia i przygotowanie planu na kolejny dzień."
                },
            ),
        )
    }
}
