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
                WebView webView = getBridge() == null ? null : getBridge().getWebView();
                if (webView != null && webView.canGoBack()) {
                    // Detail pages add a history entry; Back closes that page
                    // through popstate before the Activity can leave the app.
                    webView.goBack();
                } else {
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                    setEnabled(true);
                }
            }
        });
        splash.setOnExitAnimationListener(provider -> provider.getView().animate()
            .alpha(0f)
            .setDuration(160)
            .withEndAction(provider::remove)
            .start());
    }
}
