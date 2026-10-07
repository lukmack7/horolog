package pl.macheta.horolog

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.LocalDate
import java.time.LocalTime
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.ZonedDateTime
import java.util.concurrent.TimeUnit

class NotificationSyncWorker(
    appContext: Context,
    params: WorkerParameters,
) : Worker(appContext, params) {
    override fun doWork(): Result {
        return try {
            val settings = getJson("/api/settings/notifications")
            val plan = getJson("/api/plan")
            val intents = getArray("/api/intents")
            val todos = getArray("/api/todos")

            val alarms = mutableListOf<AlarmSpec>()
            appendScheduleAlarms(settings, plan, alarms)
            appendDeadlineAlarms(settings, intents, alarms, "intent")
            appendDeadlineAlarms(settings, todos, alarms, "todo")
            appendEndOfDayAlarm(settings, alarms)

            NotificationScheduler.replaceAll(applicationContext, alarms)
            Result.success()
        } catch (_: Exception) {
            // Keep the previous alarms intact. WorkManager will try again later.
            Result.retry()
        }
    }

    private fun appendScheduleAlarms(
        settings: JSONObject,
        plan: JSONObject,
        alarms: MutableList<AlarmSpec>,
    ) {
        val blocks = plan.optJSONArray("blocks") ?: JSONArray()

        for (index in 0 until blocks.length()) {
            val block = blocks.getJSONObject(index)
            if (block.optBoolean("completed", false)) continue

            val kind = block.optString("kind")
            val title = block.optString("title", "Horolog")
            val intentId = block.optString("intent_id", "block")
            val occurrence = block.optInt("occurrence", 0)
            val chunk = block.optInt("chunk", 0)
            val start = OffsetDateTime.parse(block.getString("start"))
            val startMillis = start.toInstant().toEpochMilli()

            when (kind) {
                "meeting" -> {
                    if (!settings.optBoolean("meeting_enabled", true)) continue
                    val before = settings.optInt("meeting_minutes_before", 15)
                    if (before > 0) {
                        alarms += AlarmSpec(
                            key = "meeting-before:$intentId:$occurrence:$chunk:$before",
                            triggerAtMillis = start.minusMinutes(before.toLong()).toInstant().toEpochMilli(),
                            title = title,
                            message = "Spotkanie rozpocznie się za $before min.",
                            channel = NotificationChannels.SCHEDULE,
                            deepLink = "horolog://planner",
                        )
                    }
                    if (settings.optBoolean("meeting_at_start", true)) {
                        alarms += AlarmSpec(
                            key = "meeting-start:$intentId:$occurrence:$chunk",
                            triggerAtMillis = startMillis,
                            title = title,
                            message = "Spotkanie zaczyna się teraz.",
                            channel = NotificationChannels.SCHEDULE,
                            deepLink = "horolog://planner",
                        )
                    }
                }

                "task", "focus", "habit" -> {
                    if (!settings.optBoolean("task_enabled", true)) continue
                    val before = settings.optInt("task_minutes_before", 15)
                    if (before > 0) {
                        alarms += AlarmSpec(
                            key = "task-before:$intentId:$occurrence:$chunk:$before",
                            triggerAtMillis = start.minusMinutes(before.toLong()).toInstant().toEpochMilli(),
                            title = title,
                            message = "Zaplanowany blok rozpocznie się za $before min.",
                            channel = NotificationChannels.SCHEDULE,
                            deepLink = "horolog://planner",
                        )
                    }
                    if (settings.optBoolean("task_at_start", true)) {
                        alarms += AlarmSpec(
                            key = "task-start:$intentId:$occurrence:$chunk",
                            triggerAtMillis = startMillis,
                            title = title,
                            message = "Czas rozpocząć ten blok.",
                            channel = NotificationChannels.SCHEDULE,
                            deepLink = "horolog://planner",
                        )
                    }
                }
            }
        }
    }

    private fun appendDeadlineAlarms(
        settings: JSONObject,
        intents: JSONArray,
        alarms: MutableList<AlarmSpec>,
        source: String,
    ) {
        if (!settings.optBoolean("deadline_enabled", true)) return

        val daysBefore = settings.optInt("deadline_days_before", 1).toLong()
        val timeMin = settings.optInt("deadline_time_min", 9 * 60)
        val hour = timeMin / 60
        val minute = timeMin % 60
        val zone = ZoneId.systemDefault()

        for (index in 0 until intents.length()) {
            val intent = intents.getJSONObject(index)
            if (!intent.isNull("completed_at")) continue
            if (intent.isNull("deadline_date")) continue

            val deadlineText = intent.optString("deadline_date")
            if (deadlineText.isBlank() || deadlineText == "null") continue

            val deadline = LocalDate.parse(deadlineText)
            val reminderDay = deadline.minusDays(daysBefore)
            val trigger = reminderDay.atTime(hour, minute).atZone(zone)

            alarms += AlarmSpec(
                key = "deadline:$source:${intent.optString("id")}:$deadlineText:$daysBefore:$timeMin",
                triggerAtMillis = trigger.toInstant().toEpochMilli(),
                title = intent.optString("title", "Deadline"),
                message = if (daysBefore == 0L) {
                    "To zadanie ma dzisiaj maksymalny deadline."
                } else {
                    "Maksymalny deadline za " + daysBefore + " " +
                        if (daysBefore == 1L) "dzień." else "dni."
                },
                channel = NotificationChannels.DEADLINES,
                deepLink = "horolog://planner",
            )
        }
    }

    private fun appendEndOfDayAlarm(
        settings: JSONObject,
        alarms: MutableList<AlarmSpec>,
    ) {
        if (!settings.optBoolean("end_of_day_enabled", true)) return

        val timeMin = settings.optInt("end_of_day_time_min", 20 * 60 + 30)
        val time = LocalTime.of(timeMin / 60, timeMin % 60)
        val zone = ZoneId.systemDefault()
        val now = ZonedDateTime.now(zone)

        var trigger = now.toLocalDate().atTime(time).atZone(zone)
        if (!trigger.isAfter(now)) {
            val sameMinute =
                trigger.toLocalDate() == now.toLocalDate() &&
                trigger.hour == now.hour &&
                trigger.minute == now.minute
            trigger = if (sameMinute) {
                now.plusSeconds(3)
            } else {
                trigger.plusDays(1)
            }
        }

        alarms += AlarmSpec(
            key = "end-of-day:${trigger.toLocalDate()}:$timeMin",
            triggerAtMillis = trigger.toInstant().toEpochMilli(),
            title = "Koniec dnia",
            message = "Podsumuj dzisiejszy dzień i dopracuj plan na jutro.",
            channel = NotificationChannels.DAILY_REVIEW,
            deepLink = "horolog://daily",
        )
    }

    private fun getJson(path: String): JSONObject = JSONObject(get(path))

    private fun getArray(path: String): JSONArray = JSONArray(get(path))

    private fun get(path: String): String {
        val connection = URL(BuildConfig.HOROLOG_BASE_URL.trimEnd('/') + path)
            .openConnection() as HttpURLConnection
        connection.connectTimeout = 8_000
        connection.readTimeout = 8_000
        connection.requestMethod = "GET"
        connection.setRequestProperty("Accept", "application/json")

        try {
            val status = connection.responseCode
            if (status !in 200..299) {
                throw IllegalStateException("Horolog API returned HTTP $status")
            }
            return connection.inputStream.bufferedReader().use { it.readText() }
        } finally {
            connection.disconnect()
        }
    }

    companion object {
        private const val PERIODIC_WORK = "horolog-notification-sync"
        private const val IMMEDIATE_WORK = "horolog-notification-sync-now"

        fun schedule(context: Context) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()

            val periodic = PeriodicWorkRequestBuilder<NotificationSyncWorker>(
                15,
                TimeUnit.MINUTES,
            )
                .setConstraints(constraints)
                .build()

            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                PERIODIC_WORK,
                ExistingPeriodicWorkPolicy.KEEP,
                periodic,
            )

            syncNow(context)
        }

        fun syncNow(context: Context) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()

            val immediate = OneTimeWorkRequestBuilder<NotificationSyncWorker>()
                .setConstraints(constraints)
                .build()

            WorkManager.getInstance(context).enqueueUniqueWork(
                IMMEDIATE_WORK,
                ExistingWorkPolicy.REPLACE,
                immediate,
            )
        }
    }
}
