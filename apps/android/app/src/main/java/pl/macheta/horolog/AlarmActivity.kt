package pl.macheta.horolog

import android.app.NotificationManager
import android.content.Context
import android.graphics.Color
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.view.Gravity
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity

class AlarmActivity : ComponentActivity() {
    private var player: MediaPlayer? = null
    private var vibrator: Vibrator? = null
    private var notificationId: Int = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        setShowWhenLocked(true)
        setTurnScreenOn(true)
        window.addFlags(
            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or
                WindowManager.LayoutParams.FLAG_ALLOW_LOCK_WHILE_SCREEN_ON,
        )

        notificationId = intent.getIntExtra(
            NotificationAlarmReceiver.EXTRA_NOTIFICATION_ID,
            0,
        )
        setContentView(buildView())
        startSoundAndVibration()
    }

    override fun onDestroy() {
        stopAlarm()
        super.onDestroy()
    }

    private fun buildView(): LinearLayout {
        val title = intent.getStringExtra(NotificationAlarmReceiver.EXTRA_TITLE)
            ?: "Planer Horolog"
        val message = intent.getStringExtra(NotificationAlarmReceiver.EXTRA_MESSAGE)
            ?: "Czas na zaplanowane działanie."

        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(56, 72, 56, 72)
            setBackgroundColor(Color.rgb(250, 249, 247))

            addView(TextView(context).apply {
                text = "PLANER HOROLOG"
                textSize = 13f
                letterSpacing = 0.12f
                setTextColor(Color.rgb(113, 113, 122))
                gravity = Gravity.CENTER
            })

            addView(TextView(context).apply {
                text = title
                textSize = 32f
                setTextColor(Color.rgb(24, 24, 27))
                gravity = Gravity.CENTER
                setPadding(0, 36, 0, 14)
            })

            addView(TextView(context).apply {
                text = message
                textSize = 18f
                setTextColor(Color.rgb(82, 82, 91))
                gravity = Gravity.CENTER
                setPadding(0, 0, 0, 56)
            })

            addView(Button(context).apply {
                text = "Zamknij"
                textSize = 17f
                setOnClickListener {
                    dismissNotification()
                    stopAlarm()
                    finish()
                }
            })

            addView(Button(context).apply {
                text = "Przypomnij za 10 min"
                textSize = 15f
                setOnClickListener {
                    NotificationScheduler.scheduleSnooze(
                        context = this@AlarmActivity,
                        title = title,
                        message = "Ponowne przypomnienie: $message",
                        minutes = 10,
                    )
                    dismissNotification()
                    stopAlarm()
                    finish()
                }
            })
        }
    }

    private fun startSoundAndVibration() {
        val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)

        runCatching {
            player = MediaPlayer().apply {
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build(),
                )
                setDataSource(this@AlarmActivity, uri)
                isLooping = true
                prepare()
                start()
            }
        }

        vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            getSystemService(VibratorManager::class.java).defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        }

        val pattern = longArrayOf(0, 700, 350, 700, 350)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            vibrator?.vibrate(VibrationEffect.createWaveform(pattern, 0))
        } else {
            @Suppress("DEPRECATION")
            vibrator?.vibrate(pattern, 0)
        }
    }

    private fun stopAlarm() {
        runCatching {
            player?.stop()
            player?.release()
        }
        player = null
        vibrator?.cancel()
    }

    private fun dismissNotification() {
        if (notificationId != 0) {
            getSystemService(NotificationManager::class.java).cancel(notificationId)
        }
    }
}
