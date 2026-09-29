const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

function withShareReceiver(config) {
  config = withAndroidManifest(config, (config) => {
    const androidManifest = config.modResults;
    const application = androidManifest.manifest.application[0];
    const mainActivity = application.activity.find(a => a.$['android:name'] === '.MainActivity');

    if (mainActivity && mainActivity['intent-filter']) {
      mainActivity['intent-filter'] = mainActivity['intent-filter'].filter(filter => {
        if (!filter.action) return true;
        const actions = filter.action.map(a => a.$['android:name']);
        return !actions.includes('android.intent.action.SEND') &&
               !actions.includes('android.intent.action.SEND_MULTIPLE');
      });
    }

    application.activity.push({
      $: {
        'android:name': '.ShareReceiverActivity',
        'android:theme': '@android:style/Theme.Translucent.NoTitleBar',
        'android:launchMode': 'singleTask',
        'android:exported': 'true'
      },
      'intent-filter': [
        {
          action: [{ $: { 'android:name': 'android.intent.action.SEND' } }],
          category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }],
          data: [
            { $: { 'android:mimeType': 'text/*' } },
            { $: { 'android:mimeType': 'image/*' } },
            { $: { 'android:mimeType': 'video/*' } }
          ]
        },
        {
          action: [{ $: { 'android:name': 'android.intent.action.SEND_MULTIPLE' } }],
          category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }],
          data: [
            { $: { 'android:mimeType': 'image/*' } },
            { $: { 'android:mimeType': 'video/*' } }
          ]
        }
      ]
    });
    return config;
  });

  config = withDangerousMod(config, [
    'android',
    async (config) => {
      const projectRoot = config.modRequest.projectRoot;
      const packageName = config.android.package;
      const packagePath = packageName.replace(/\./g, '/');
      const targetDir = path.join(projectRoot, 'android/app/src/main/java', packagePath);

      const activityCode = `package ${packageName}

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.util.Locale
import android.os.Build

class ShareReceiverActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        var success = false
        try {
            success = handleIntent(intent)
        } catch (e: Exception) {
            e.printStackTrace()
        }

        if (success) {
            val message = if (Locale.getDefault().language == "ko") "Keepory로 전송되었습니다" else "Sent to Keepory"
            Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
        }
        finish()
    }

    private fun <T : android.os.Parcelable> getParcelableExtraCompat(intent: Intent, name: String, clazz: Class<T>): T? {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(name, clazz)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(name) as? T
        }
    }

    private fun <T : android.os.Parcelable> getParcelableArrayListExtraCompat(intent: Intent, name: String, clazz: Class<T>): ArrayList<T>? {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableArrayListExtra(name, clazz)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableArrayListExtra<T>(name)
        }
    }

    private fun handleIntent(intent: Intent): Boolean {
        val action = intent.action
        val type = intent.type ?: return false

        val item = JSONObject()
        val id = UUID.randomUUID().toString()
        item.put("id", id)
        item.put("timestamp", System.currentTimeMillis())
        item.put("type", type)

        var hasData = false

        if (Intent.ACTION_SEND == action) {
            if (type.startsWith("text/")) {
                val text = intent.getStringExtra(Intent.EXTRA_TEXT)
                if (text != null) {
                    item.put("text", text)
                    item.put("title", intent.getStringExtra(Intent.EXTRA_TITLE))
                    hasData = true
                }
            } else {
                val uri = getParcelableExtraCompat(intent, Intent.EXTRA_STREAM, Uri::class.java)
                if (uri != null) {
                    val path = copyFile(uri)
                    if (path != null) {
                        item.put("file", path)
                        item.put("mimeType", type)
                        hasData = true
                    }
                }
            }
        } else if (Intent.ACTION_SEND_MULTIPLE == action) {
            val uris = getParcelableArrayListExtraCompat(intent, Intent.EXTRA_STREAM, Uri::class.java)
            if (uris != null) {
                val paths = JSONArray()
                uris.forEach { uri ->
                    copyFile(uri)?.let { paths.put(it) }
                }
                if (paths.length() > 0) {
                    item.put("files", paths)
                    item.put("mimeType", type)
                    hasData = true
                }
            }
        }

        val targetDir = File(filesDir, "pending_shares")
        targetDir.mkdirs()

        if (hasData) {
            val sharesFile = File(targetDir, "share_\${id}.json")
            sharesFile.writeText(item.toString())
            return true
        }
        return false
    }

    private fun copyFile(uri: Uri): String? {
        try {
            val resolver = contentResolver
            val mimeType = resolver.getType(uri) ?: "application/octet-stream"
            val ext = android.webkit.MimeTypeMap.getSingleton().getExtensionFromMimeType(mimeType) ?: "bin"

            val targetDir = File(filesDir, "pending_shares")
            targetDir.mkdirs()
            val targetFile = File(targetDir, "share_img_\${UUID.randomUUID()}.$ext")

            resolver.openInputStream(uri)?.use { input ->
                FileOutputStream(targetFile).use { output ->
                    input.copyTo(output)
                }
            }
            return targetFile.absolutePath
        } catch (e: Exception) {
            e.printStackTrace()
            return null
        }
    }
}
`;
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, 'ShareReceiverActivity.kt'), activityCode);
      return config;
    }
  ]);

  return config;
}

module.exports = withShareReceiver;
