package de.diewehmut.selbstlauf;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Only encrypted bearer credentials are written to private app preferences. */
@CapacitorPlugin(name = "Credentials")
public class CredentialsPlugin extends Plugin {
    private static final String ALIAS = "selbstlauf.remote.credentials.v1";
    private SharedPreferences preferences() {
        return getContext().getSharedPreferences("remote_credentials", Context.MODE_PRIVATE);
    }
    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (!store.containsAlias(ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            generator.generateKey();
        }
        return (SecretKey) store.getKey(ALIAS, null);
    }
    @PluginMethod public synchronized void get(PluginCall call) {
        String name = call.getString("key");
        if (name == null) { call.reject("Missing credential key"); return; }
        try {
            String record = preferences().getString(name, null);
            JSObject result = new JSObject();
            if (record == null) { result.put("value", org.json.JSONObject.NULL); }
            else {
                String[] parts = record.split(":", 2);
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
                cipher.updateAAD(name.getBytes(StandardCharsets.UTF_8));
                result.put("value", new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8));
            }
            call.resolve(result);
        } catch (Exception error) { call.reject("Unable to unlock device credential; pair again"); }
    }
    @PluginMethod public synchronized void set(PluginCall call) {
        String name = call.getString("key"), value = call.getString("value");
        if (name == null || value == null) { call.reject("Missing credential"); return; }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            cipher.updateAAD(name.getBytes(StandardCharsets.UTF_8));
            String encrypted = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":" +
                Base64.encodeToString(cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
            if (!preferences().edit().putString(name, encrypted).commit()) throw new Exception();
            call.resolve();
        } catch (Exception error) { call.reject("Unable to save device credential"); }
    }
    @PluginMethod public void remove(PluginCall call) {
        String name = call.getString("key");
        if (name == null) { call.reject("Missing credential key"); return; }
        if (preferences().edit().remove(name).commit()) call.resolve();
        else call.reject("Unable to remove device credential");
    }
}
