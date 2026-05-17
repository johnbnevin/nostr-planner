#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        // Deep-link plugin — receives Amber's nostrconnect:// intent on
        // Android, bunker:// URIs from any signer app, and the same
        // schemes on iOS/desktop. The JS side subscribes via
        // @tauri-apps/plugin-deep-link.
        .plugin(tauri_plugin_deep_link::init())
        .run(tauri::generate_context!())
        .expect("error while running nostr-planner");
}
