package pl.macheta.horolog

import android.Manifest
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

class NotificationAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        showNow(
            context = context,
            title = intent.getStringExtra(EXTRA_TITLE) ?: "Planer Horolog",
            message = intent.getStringExtra(EXTRA_MESSAGE) ?: "",
            channel = intent.getStringExtra(EXTRA_CHANNEL) ?: NotificationChannels.SCHEDULE,
            deepLink = intent.getStringExtra(EXTRA_DEEP_LINK) ?: "horolog://planner",
            notificationId = intent.getIntExtra(EXTRA_NOTIFICATION_ID, 0),
        )
    }

    companion object {
        const val ACTION_NOTIFY = "pl.macheta.horolog.NOTIFY"
        const val EXTRA_TITLE = "title"
        const val EXTRA_MESSAGE = "message"
        const val EXTRA_CHANNEL = "channel"
        const val EXTRA_DEEP_LINK = "deep_link"
        const val EXTRA_NOTIFICATION_ID = "notification_id"

        fun showNow(
            context: Context,
            title: String,
            message: String,
            channel: String,
            deepLink: String,
            notificationId: Int,
        ) {
            if (
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                ContextCompat.checkSelfPermission(
                    context,
                    Manifest.permission.POST_NOTIFICATIONS,
                ) != PackageManager.PERMISSION_GRANTED
            ) {
                return
            }

            val id = if (notificationId != 0) notificationId else title.hashCode()
            val openIntent = Intent(
                Intent.ACTION_VIEW,
                android.net.Uri.parse(deepLink),
                context,
                MainActivity::class.java,
            )
            val openPendingIntent = PendingIntent.getActivity(
                context,
                id,
                openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )

            val notification = NotificationCompat.Builder(context, channel)
                .setSmallIcon(R.drawable.ic_horolog)
                .setContentTitle(title)
                .setContentText(message)
                .setStyle(NotificationCompat.BigTextStyle().bigText(message))
                .setContentIntent(openPendingIntent)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .build()

            NotificationManagerCompat.from(context).notify(id, notification)
        }
    }
}
