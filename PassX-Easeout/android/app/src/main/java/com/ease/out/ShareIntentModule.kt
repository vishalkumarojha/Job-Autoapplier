package com.ease.out

import android.content.Intent
import com.facebook.react.ReactApplication
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.uimanager.ViewManager

class ShareIntentModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  override fun getName() = "ShareIntentModule"

  @ReactMethod
  fun getInitialText(promise: Promise) {
    promise.resolve(pendingText)
    pendingText = null
  }

  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Int) {}

  companion object {
    @Volatile private var pendingText: String? = null

    fun capture(intent: Intent?, emit: Boolean) {
      if (intent?.action != Intent.ACTION_SEND || intent.type != "text/plain") return
      val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.trim().orEmpty()
      if (text.isEmpty()) return
      pendingText = text
      if (emit) {
        // The active React context is obtained by the package's application host.
        val app = currentApplication
        val reactContext = (app as? ReactApplication)?.reactNativeHost?.reactInstanceManager?.currentReactContext
        reactContext?.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)?.emit("sharedText", text)
      }
    }

    @Volatile private var currentApplication: android.app.Application? = null
    fun setApplication(application: android.app.Application) { currentApplication = application }
  }
}

class ShareIntentPackage : ReactPackage {
  override fun createNativeModules(context: ReactApplicationContext) = listOf(ShareIntentModule(context))
  override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
