package expo.modules.sharereturn

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Returns the user to the app a URL was shared from, so a Stash share can feel
 * like a fire-and-forget capture instead of a context switch into Stash.
 *
 * `expo-share-intent` always launches the host app to hand off the shared data
 * (there is no inline-handling mode), so once Stash has captured the URL we drop
 * its task back to the background — Android then reveals the previous app. This
 * is the only piece that has to be native: there is no React Native API for
 * `Activity.moveTaskToBack`, and an app cannot background itself on iOS at all,
 * which is why this module is Android-only.
 */
class ShareReturnModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ShareReturn")

    // `nonRoot = true`: only move the task if Stash isn't the root of its task,
    // matching the "step back to where you came from" intent. Returns whether
    // Android actually moved the task (false when there's no activity yet).
    Function("moveTaskToBack") {
      val activity = appContext.currentActivity ?: return@Function false
      activity.moveTaskToBack(true)
    }
  }
}
