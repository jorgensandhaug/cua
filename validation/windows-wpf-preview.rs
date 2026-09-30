#![cfg(target_os = "windows")]

use cua_driver_testkit::{ax, harness_app, spawn_in_job, Driver, McpDriver};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn wait_for_counter(path: &Path, expected: &str) {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Ok(bytes) = std::fs::read(path) {
            if let Ok(state) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                if state["lbl-counter"]["text"].as_str() == Some(expected) {
                    return;
                }
            }
        }
        assert!(
            Instant::now() < deadline,
            "fixture counter did not reach {expected}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Validation-only experiment. The driver/native libraries remain at the frozen
/// source SHA; only this separate test target is overlaid.
#[test]
#[ignore = "requires an isolated interactive Windows desktop and WPF fixture"]
fn live_previews_keep_semantic_target() {
    let artifacts =
        PathBuf::from(std::env::var_os("CUA_PREVIEW_ARTIFACTS").expect("artifact directory"));
    std::fs::create_dir_all(&artifacts).expect("owned artifact directory");
    let state_path = artifacts.join("fixture-state.json");
    let mut driver =
        McpDriver::spawn_named("opengeni-wpf-live-preview").expect("source-built driver");
    let mut command = Command::new(harness_app("harness-wpf", "CuaTestHarness.Wpf.exe"));
    command
        .env("CUA_E2E_FIXTURE_STATE_PATH", &state_path)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let app = spawn_in_job(&mut command).expect("required WPF fixture");
    let pid = app.id();
    driver.reaper().push(app);
    let (window_id, _) = driver
        .find_window(pid as i64, "CuaTestHarness WPF")
        .expect("owned fixture window");
    wait_for_counter(&state_path, "counter=0");
    let observe = serde_json::json!({
        "pid": pid as i64, "window_id": window_id,
        "include_screenshot": false, "include_accessibility_tree": true
    });
    let first = driver.call("get_window_state", observe.clone());
    assert!(
        !first.is_error(),
        "initial observation failed: {}",
        first.text()
    );
    let index =
        ax::element_index_by_id(first.tree_text(), "btn-increment").expect("increment control");
    let token = first.element_token(index);
    for preview in 0..5 {
        let capture = driver.call(
            "get_window_state",
            serde_json::json!({
                "pid": pid as i64, "window_id": window_id,
                "include_screenshot": true, "include_accessibility_tree": false
            }),
        );
        assert!(!capture.is_error(), "preview failed: {}", capture.text());
        let encoded = capture.raw["result"]["content"]
            .as_array()
            .and_then(|items| {
                items.iter().find_map(|item| {
                    (item["type"] == "image")
                        .then(|| item["data"].as_str())
                        .flatten()
                })
            })
            .expect("preview image");
        let png = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encoded)
            .expect("preview base64");
        let image = image::load_from_memory(&png).expect("real preview PNG");
        assert!(
            image.width() > 300 && image.height() > 300,
            "empty preview dimensions"
        );
        std::fs::write(artifacts.join(format!("preview-{preview}.png")), png)
            .expect("retain fixture PNG");
    }
    let click = serde_json::json!({
        "pid": pid as i64, "window_id": window_id,
        "element_token": token, "delivery_mode": "background"
    });
    let delivered = driver.call("click", click.clone());
    assert!(
        !delivered.is_error(),
        "preview_semantic_click_failed: code={} {}",
        delivered.structured()["refusal"]["code"]
            .as_str()
            .unwrap_or("unknown"),
        delivered.text()
    );
    wait_for_counter(&state_path, "counter=1");
    // Actual semantic reads still replace handles. The old one must refuse
    // exactly, without producing another increment in the independent fixture.
    let newer = driver.call("get_window_state", observe);
    assert!(
        !newer.is_error(),
        "new semantic read failed: {}",
        newer.text()
    );
    let refused = driver.call("click", click);
    assert!(
        refused.is_error(),
        "old handle accepted after semantic read"
    );
    assert_eq!(
        refused.structured()["refusal"]["code"].as_str(),
        Some("stale_element_token")
    );
    wait_for_counter(&state_path, "counter=1");
    println!("preview_keeper_passed: five real previews; exactly one increment; new semantic read rejects old handle");
}
