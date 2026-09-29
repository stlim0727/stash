const { withAndroidManifest, withDangerousMod, AndroidConfig } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

function withShareReceiver(config) {
  // 1. Modify AndroidManifest.xml
  config = withAndroidManifest(config, (config) => {
    const androidManifest = config.modResults;
    const application = androidManifest.manifest.application[0];
    const mainActivity = application.activity.find(a => a.$['android:name'] === '.MainActivity');

    // Remove ACTION_SEND and ACTION_SEND_MULTIPLE from MainActivity
    if (mainActivity && mainActivity['intent-filter']) {
      mainActivity['intent-filter'] = mainActivity['intent-filter'].filter(filter => {
        if (!filter.action) return true;
        const actions = filter.action.map(a => a.$['android:name']);
        return !actions.includes('android.intent.action.SEND') && 
               !actions.includes('android.intent.action.SEND_MULTIPLE');
      });
    }

    // Add ShareReceiverActivity
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

  // 2. Inject ShareReceiverActivity.kt
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
            val message = if (Locale.getDefault().language == "ko") "Stash에 저장되었습니다" else "Saved to Stash"
            Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
        }
        finish()
    }

    private fun handleIntent(intent: Intent): Boolean {
        val action = intent.action
        val type = intent.type ?: return false

        val sharesFile = File(filesDir, "pending_shares.json")
        val shares = if (sharesFile.exists()) {
            try {
                JSONArray(sharesFile.readText())
            } catch (e: Exception) {
                JSONArray()
            }
        } else {
            JSONArray()
        }

        val item = JSONObject()
        item.put("id", UUID.randomUUID().toString())
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
                val uri = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
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
            val uris = intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
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

        if (hasData) {
            shares.put(item)
            sharesFile.writeText(shares.toString())
            return true
        }
        return false
    }

    private fun copyFile(uri: Uri): String? {
        try {
            val resolver = contentResolver
            val mimeType = resolver.getType(uri) ?: "application/octet-stream"
            val ext = android.webkit.MimeTypeMap.getSingleton().getExtensionFromMimeType(mimeType) ?: "bin"
            val targetFile = File(cacheDir, "share_img_\${System.currentTimeMillis()}.\$ext")
            
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
