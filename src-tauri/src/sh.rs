//! Thin helpers over the Tauri shell plugin for invoking the bundled sidecars
//! (yt-dlp / ffmpeg / ffprobe), both one-shot (capture) and streaming (progress).

use crate::AppState;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

/// Run a sidecar to completion, returning (success, stdout, stderr).
pub async fn capture(
    app: &AppHandle,
    bin: &str,
    args: Vec<String>,
) -> Result<(bool, String, String), String> {
    let out = app
        .shell()
        .sidecar(bin)
        .map_err(|e| format!("sidecar {bin}: {e}"))?
        .args(args)
        .output()
        .await
        .map_err(|e| format!("{bin}: {e}"))?;
    Ok((
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    ))
}

/// Run a sidecar, delivering each stdout/stderr line to `on_line(line, is_stderr)`.
/// The child is registered in [`AppState`] so `cancel_job` can kill it. Returns
/// whether the process exited successfully.
pub async fn stream<F: FnMut(String, bool)>(
    app: &AppHandle,
    bin: &str,
    args: Vec<String>,
    mut on_line: F,
) -> Result<bool, String> {
    let (mut rx, child) = app
        .shell()
        .sidecar(bin)
        .map_err(|e| format!("sidecar {bin}: {e}"))?
        .args(args)
        .spawn()
        .map_err(|e| format!("{bin}: {e}"))?;

    {
        let state = app.state::<AppState>();
        *state.current_child.lock().unwrap() = Some(child);
    }

    let mut success = false;
    while let Some(ev) = rx.recv().await {
        match ev {
            CommandEvent::Stdout(b) => on_line(String::from_utf8_lossy(&b).into_owned(), false),
            CommandEvent::Stderr(b) => on_line(String::from_utf8_lossy(&b).into_owned(), true),
            CommandEvent::Error(e) => on_line(e, true),
            CommandEvent::Terminated(payload) => success = payload.code == Some(0),
            _ => {}
        }
    }

    {
        let state = app.state::<AppState>();
        *state.current_child.lock().unwrap() = None;
    }
    Ok(success)
}

/// Last few lines of a (possibly long) stderr blob, for error messages.
pub fn tail(s: &str, n: usize) -> String {
    let lines: Vec<&str> = s.lines().filter(|l| !l.trim().is_empty()).collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}
