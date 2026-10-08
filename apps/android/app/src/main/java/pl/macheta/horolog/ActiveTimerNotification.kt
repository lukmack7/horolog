package pl.macheta.horolog

import android.Manifest
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject

object ActiveTimerNotification {
    private const val NOTIFICATION_ID = 20261009

    fun update(context: Context, timer: JSONObject?) {
        val manager = NotificationManagerCompat.from(context)
        if (timer == null) {
            manager.cancel(NOTIFICATION_ID)
            return
        }

        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return
        }

        val intentId = timer.optString("intent_id")
        val deepLink = HorologDeepLinks.time(intentId)
        val openIntent = Intent(
            Intent.ACTION_VIEW,
            Uri.parse(deepLink),
            context,
            MainActivity::class.java,
        )
        val openPendingIntent = PendingIntent.getActivity(
            context,
            NOTIFICATION_ID,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val elapsedSeconds = timer.optLong("elapsed_seconds").coerceAtLeast(0)
        val running = timer.optString("status") == "running"
        val builder = NotificationCompat.Builder(context, NotificationChannels.ACTIVE_TIMER)
            .setSmallIcon(R.drawable.ic_horolog)
            .setContentTitle(timer.optString("title", "Aktywny timer"))
            .setContentIntent(openPendingIntent)
            .addAction(R.drawable.ic_horolog, "Otwórz zadanie", openPendingIntent)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)

        if (running) {
            builder
                .setContentText("Timer działa")
                .setWhen(System.currentTimeMillis() - elapsedSeconds * 1_000L)
                .setShowWhen(true)
                .setUsesChronometer(true)
        } else {
            builder
                .setContentText("Wstrzymany - ${formatElapsed(elapsedSeconds)}")
                .setShowWhen(false)
                .setUsesChronometer(false)
        }

        manager.notify(NOTIFICATION_ID, builder.build())
    }

    private fun formatElapsed(totalSeconds: Long): String {
        val hours = totalSeconds / 3_600
        val minutes = totalSeconds % 3_600 / 60
        val seconds = totalSeconds % 60
        return if (hours > 0) {
            "%d:%02d:%02d".format(hours, minutes, seconds)
        } else {
            "%d:%02d".format(minutes, seconds)
        }
    }
}
