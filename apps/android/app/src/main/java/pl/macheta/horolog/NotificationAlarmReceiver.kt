package pl.macheta.horolog

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

class NotificationAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val title = intent.getStringExtra(EXTRA_TITLE) ?: "Planer Horolog"
        val message = intent.getStringExtra(EXTRA_MESSAGE) ?: ""
        val channel = intent.getStringExtra(EXTRA_CHANNEL) ?: NotificationChannels.SCHEDULE
        val deepLink = intent.getStringExtra(EXTRA_DEEP_LINK) ?: "horolog://planner"
        val notificationId = intent.getIntExtra(EXTRA_NOTIFICATION_ID, title.hashCode())

        val openIntent = Intent(
            Intent.ACTION_VIEW,
            android.net.Uri.parse(deepLink),
            context,
            MainActivity::class.java,
        )
        val openPendingIntent = PendingIntent.getActivity(
            context,
            notificationId,
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

        NotificationManagerCompat.from(context).notify(notificationId, notification)
    }

    companion object {
        const val ACTION_NOTIFY = "pl.macheta.horolog.NOTIFY"
        const val EXTRA_TITLE = "title"
        const val EXTRA_MESSAGE = "message"
        const val EXTRA_CHANNEL = "channel"
        const val EXTRA_DEEP_LINK = "deep_link"
        const val EXTRA_NOTIFICATION_ID = "notification_id"
    }
}
