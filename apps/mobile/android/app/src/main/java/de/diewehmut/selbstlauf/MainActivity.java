package de.diewehmut.selbstlauf;

import android.os.Bundle;
import android.os.Build;
import android.graphics.Color;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.EdgeToEdge;
import androidx.core.splashscreen.SplashScreen;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {
    private boolean webReady;
    private boolean backPending;

    @Override public void onCreate(Bundle savedInstanceState) {
        SplashScreen splash = SplashScreen.installSplashScreen(this);
        splash.setKeepOnScreenCondition(() -> !webReady);
        bridgeBuilder.addWebViewListener(new WebViewListener() {
            @Override public void onPageLoaded(WebView webView) {
                webView.post(() -> webReady = true);
            }
        });
        registerPlugin(CredentialsPlugin.class);
        super.onCreate(savedInstanceState);
        EdgeToEdge.enable(this);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            getWindow().setNavigationBarContrastEnforced(false);
        }
        getWindow().getDecorView().setBackgroundColor(Color.rgb(27, 17, 14));
        if (getBridge() != null) getBridge().getWebView().setBackgroundColor(Color.rgb(27, 17, 14));
        // A missing or failed WebView must still reveal the native error UI.
        getWindow().getDecorView().postDelayed(() -> webReady = true, 3500);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() {
                if (backPending) return;
                WebView webView = getBridge() == null ? null : getBridge().getWebView();
                if (webView == null) {
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                    setEnabled(true);
                    return;
                }
                backPending = true;
                // App routes use same-document history. Ask the running Vue
                // application before deciding whether Back may leave Android.
                webView.evaluateJavascript(
                    "typeof window.selbstlaufNavigateBack === 'function' ? window.selbstlaufNavigateBack() : null",
                    handled -> {
                        backPending = false;
                        if ("true".equals(handled)) return;
                        if ("null".equals(handled) && webView.canGoBack()) {
                            webView.goBack();
                            return;
                        }
                        setEnabled(false);
                        getOnBackPressedDispatcher().onBackPressed();
                        setEnabled(true);
                    });
            }
        });
        splash.setOnExitAnimationListener(provider -> provider.getView().animate()
            .alpha(0f)
            .setDuration(160)
            .withEndAction(provider::remove)
            .start());
    }
}
