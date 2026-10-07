package pl.macheta.horolog

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build

object NotificationScheduler {
    private const val PREFS = "horolog_notification_alarms"
    private const val KEY_IDS = "scheduled_ids"

    fun replaceAll(context: Context, alarms: List<AlarmSpec>) {
        clearAll(context)
        val scheduled = mutableSetOf<String>()

        for (alarm in alarms) {
            if (alarm.triggerAtMillis <= System.currentTimeMillis()) continue

            val requestCode = alarm.key.hashCode()
            val intent = Intent(context, NotificationAlarmReceiver::class.java).apply {
                action = NotificationAlarmReceiver.ACTION_NOTIFY
                putExtra(NotificationAlarmReceiver.EXTRA_TITLE, alarm.title)
                putExtra(NotificationAlarmReceiver.EXTRA_MESSAGE, alarm.message)
                putExtra(NotificationAlarmReceiver.EXTRA_CHANNEL, alarm.channel)
                putExtra(NotificationAlarmReceiver.EXTRA_DEEP_LINK, alarm.deepLink)
                putExtra(NotificationAlarmReceiver.EXTRA_NOTIFICATION_ID, requestCode)
            }

            val pendingIntent = PendingIntent.getBroadcast(
                context,
                requestCode,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )

            val manager = context.getSystemService(AlarmManager::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                manager.setAndAllowWhileIdle(
                    AlarmManager.RTC_WAKEUP,
                    alarm.triggerAtMillis,
                    pendingIntent,
                )
            } else {
                manager.set(
                    AlarmManager.RTC_WAKEUP,
                    alarm.triggerAtMillis,
                    pendingIntent,
                )
            }
            scheduled += requestCode.toString()
        }

        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putStringSet(KEY_IDS, scheduled)
            .apply()
    }

    private fun clearAll(context: Context) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val ids = prefs.getStringSet(KEY_IDS, emptySet()).orEmpty()
        val manager = context.getSystemService(AlarmManager::class.java)

        for (id in ids) {
            val requestCode = id.toIntOrNull() ?: continue
            val intent = Intent(context, NotificationAlarmReceiver::class.java).apply {
                action = NotificationAlarmReceiver.ACTION_NOTIFY
            }
            val pending = PendingIntent.getBroadcast(
                context,
                requestCode,
                intent,
                PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE,
            )
            if (pending != null) {
                manager.cancel(pending)
                pending.cancel()
            }
        }

        prefs.edit().remove(KEY_IDS).apply()
    }
}

data class AlarmSpec(
    val key: String,
    val triggerAtMillis: Long,
    val title: String,
    val message: String,
    val channel: String,
    val deepLink: String,
)
