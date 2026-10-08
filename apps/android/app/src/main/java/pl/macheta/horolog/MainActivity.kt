package pl.macheta.horolog

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

class MainActivity : ComponentActivity() {
    private lateinit var webView: WebView
    private lateinit var errorPanel: View

    private val baseUrl = BuildConfig.HOROLOG_BASE_URL.trimEnd('/')
    private val baseHost: String
        get() = Uri.parse(baseUrl).host.orEmpty()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        WindowCompat.setDecorFitsSystemWindows(window, false)
        NotificationChannels.create(this)
        requestNotificationPermission()
        NotificationSyncWorker.schedule(this)
        setContentView(buildContent())
        configureWebView()
        configureBackNavigation()

        load(resolveUrl(intent))
    }

    override fun onResume() {
        super.onResume()
        NotificationSyncWorker.syncNow(this)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        load(resolveUrl(intent))
    }

    private fun buildContent(): View {
        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.WHITE)
        }

        webView = WebView(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            )
        }
        root.addView(webView)

        errorPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            visibility = View.GONE
            setPadding(48, 48, 48, 48)
            setBackgroundColor(Color.WHITE)

            addView(TextView(context).apply {
                text = getString(R.string.server_unavailable)
                textSize = 20f
                setTextColor(Color.rgb(24, 24, 27))
                gravity = Gravity.CENTER
            })

            addView(TextView(context).apply {
                text = getString(R.string.server_hint)
                textSize = 14f
                setTextColor(Color.rgb(113, 113, 122))
                gravity = Gravity.CENTER
                setPadding(0, 20, 0, 32)
            })

            addView(Button(context).apply {
                text = getString(R.string.retry)
                setOnClickListener {
                    hideConnectionError()
                    load(webView.url ?: baseUrl)
                }
            })

            addView(Button(context).apply {
                text = getString(R.string.open_tailscale)
                setOnClickListener { openTailscale() }
            })

            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            )
        }
        root.addView(errorPanel)

        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.setPadding(
                systemBars.left,
                systemBars.top,
                systemBars.right,
                systemBars.bottom,
            )
            insets
        }
        ViewCompat.requestApplyInsets(root)

        return root
    }

    private inner class AndroidBridge {
        @JavascriptInterface
        fun refreshNotifications() {
            runOnUiThread {
                NotificationSyncWorker.syncNow(this@MainActivity)
            }
        }

        @JavascriptInterface
        fun testNotification() {
            runOnUiThread {
                NotificationChannels.create(this@MainActivity)
                NotificationAlarmReceiver.showNow(
                    context = this@MainActivity,
                    title = "Planer Horolog",
                    message = "Powiadomienia działają prawidłowo.",
                    channel = NotificationChannels.SCHEDULE,
                    deepLink = HorologDeepLinks.PLANNER,
                    notificationId = 20261007,
                )
            }
        }

        @JavascriptInterface
        fun alarmAccessReady(): Boolean =
            AlarmPermissionHelper.canScheduleExact(this@MainActivity) &&
                AlarmPermissionHelper.canUseFullScreen(this@MainActivity)

        @JavascriptInterface
        fun requestAlarmAccess() {
            runOnUiThread {
                when {
                    !AlarmPermissionHelper.canScheduleExact(this@MainActivity) ->
                        AlarmPermissionHelper.openExactAlarmSettings(this@MainActivity)
                    !AlarmPermissionHelper.canUseFullScreen(this@MainActivity) ->
                        AlarmPermissionHelper.openFullScreenSettings(this@MainActivity)
                }
            }
        }

        @JavascriptInterface
        fun testFullScreenAlarm() {
            runOnUiThread {
                val testIntent = Intent(this@MainActivity, AlarmActivity::class.java).apply {
                    putExtra(NotificationAlarmReceiver.EXTRA_TITLE, "Test alarmu")
                    putExtra(
                        NotificationAlarmReceiver.EXTRA_MESSAGE,
                        "Pełnoekranowy alarm Planera Horolog działa.",
                    )
                    putExtra(NotificationAlarmReceiver.EXTRA_NOTIFICATION_ID, 20261008)
                    putExtra(
                        NotificationAlarmReceiver.EXTRA_DEEP_LINK,
                        HorologDeepLinks.time("test"),
                    )
                }
                startActivity(testIntent)
            }
        }

        @JavascriptInterface
        fun notificationsAvailable(): Boolean =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                ContextCompat.checkSelfPermission(
                    this@MainActivity,
                    Manifest.permission.POST_NOTIFICATIONS,
                ) == PackageManager.PERMISSION_GRANTED
            } else {
                true
            }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = true
        }

        webView.addJavascriptInterface(AndroidBridge(), "HorologAndroid")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean {
                val uri = request.url
                if (uri.host == baseHost) return false

                return try {
                    startActivity(Intent(Intent.ACTION_VIEW, uri))
                    true
                } catch (_: Exception) {
                    false
                }
            }

            override fun onPageFinished(view: WebView, url: String) {
                hideConnectionError()
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError,
            ) {
                if (request.isForMainFrame && request.url.host == baseHost) {
                    showConnectionError()
                }
            }
        }
    }

    private fun configureBackNavigation() {
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    if (webView.canGoBack()) {
                        webView.goBack()
                    } else {
                        finish()
                    }
                }
            },
        )
    }

    private fun resolveUrl(intent: Intent?): String {
        if (intent == null) return baseUrl

        if (intent.action == Intent.ACTION_SEND && intent.type == "text/plain") {
            val shared = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim().orEmpty()
            if (shared.isNotEmpty()) {
                val encoded = URLEncoder.encode(shared, StandardCharsets.UTF_8.toString())
                return "$baseUrl/todo?prefill=$encoded"
            }
        }

        val deepLink = intent.data
        if (intent.action == Intent.ACTION_VIEW && deepLink?.scheme == "horolog") {
            return when (deepLink.host) {
                "todo" -> "$baseUrl/todo"
                "planner" -> "$baseUrl/planner"
                "daily" -> "$baseUrl/daily"
                "time" -> Uri.parse("$baseUrl/time").buildUpon().apply {
                    deepLink.getQueryParameter("focus")
                        ?.takeIf { it.isNotBlank() }
                        ?.let { appendQueryParameter("focus", it) }
                }.build().toString()
                else -> baseUrl
            }
        }

        return baseUrl
    }

    private fun load(url: String) {
        hideConnectionError()
        webView.loadUrl(url)
    }

    private fun showConnectionError() {
        webView.visibility = View.INVISIBLE
        errorPanel.visibility = View.VISIBLE
    }

    private fun hideConnectionError() {
        errorPanel.visibility = View.GONE
        webView.visibility = View.VISIBLE
    }

    private fun openTailscale() {
        val launch = packageManager.getLaunchIntentForPackage(TAILSCALE_PACKAGE)
        if (launch != null) {
            startActivity(launch)
            return
        }

        runCatching {
            startActivity(
                Intent(
                    Intent.ACTION_VIEW,
                    Uri.parse("market://details?id=$TAILSCALE_PACKAGE"),
                ),
            )
        }
    }

    private fun requestNotificationPermission() {
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(
                this,
                arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                NOTIFICATION_PERMISSION_REQUEST,
            )
        }
    }

    companion object {
        private const val TAILSCALE_PACKAGE = "com.tailscale.ipn"
        private const val NOTIFICATION_PERMISSION_REQUEST = 1001
    }
}
