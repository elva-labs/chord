//! The welcome and About, each a small window of its own.
//!
//! The welcome says what the app found on the machine: an agent, one of
//! which it needs, and git. It opens in place of the main window at the
//! first launch, and at any later launch that finds no agent on the PATH,
//! and the main window shows only once the welcome is gone through.
//! Closing the welcome before that quits the app the way Quit does, asking
//! first when work would be lost. Settings and the palette open it again
//! over the main window.
//!
//! About shows the mark, the version and the project's page. It opens from
//! About in the app menu on macOS and from the popup elsewhere.

use tauri::{
    AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window,
    WindowEvent,
};

pub const WELCOME: &str = "welcome";
pub const ABOUT: &str = "about";
const MAIN: &str = "main";

/// Opens the welcome, or brings it forward when it is open. `again` is the
/// launch that finds no agent after the first: the welcome then shows the
/// checks at once, without the animation.
pub fn open_welcome<R: Runtime>(app: &AppHandle<R>, again: bool) {
    if let Some(window) = app.get_webview_window(WELCOME) {
        let _ = window.set_focus();
        return;
    }
    let url = if again { "welcome?again" } else { "welcome" };
    let builder = WebviewWindowBuilder::new(app, WELCOME, WebviewUrl::App(url.into()))
        .title("Welcome to Chord")
        .inner_size(440.0, 460.0)
        .resizable(false)
        .maximizable(false)
        .center()
        .focused(true);
    if let Err(error) = small(builder).build() {
        eprintln!("welcome: {error}");
        show_main(app);
    }
}

/// Opens About over the main window, or brings it forward when it is open.
pub fn open_about<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(ABOUT) {
        let _ = window.set_focus();
        return;
    }
    let (width, height) = (300.0, 318.0);
    let builder = WebviewWindowBuilder::new(app, ABOUT, WebviewUrl::App("about".into()))
        .title("About Chord")
        .inner_size(width, height)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .focused(true);
    let builder = match over_main(app, width, height) {
        Some((x, y)) => builder.position(x, y),
        None => builder.center(),
    };
    if let Err(error) = small(builder).build() {
        eprintln!("about: {error}");
    }
}

/// On macOS the title bar is drawn over the page, which leaves room for the
/// window's controls; elsewhere the system draws it.
fn small<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    builder
}

/// Where a window of `width` by `height` sits centred over the main window,
/// in logical points, when the main window is showing.
fn over_main<R: Runtime>(app: &AppHandle<R>, width: f64, height: f64) -> Option<(f64, f64)> {
    let main = app
        .get_webview_window(MAIN)
        .filter(|main| main.is_visible().unwrap_or(false))?;
    let scale = main.scale_factor().ok()?;
    let position = main.outer_position().ok()?.to_logical::<f64>(scale);
    let size = main.outer_size().ok()?.to_logical::<f64>(scale);
    Some((
        position.x + (size.width - width) / 2.0,
        position.y + (size.height - height) / 2.0,
    ))
}

/// Whether the main window is showing; it is hidden while the welcome
/// stands in for it.
pub fn main_shown<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.get_webview_window(MAIN)
        .is_some_and(|main| main.is_visible().unwrap_or(false))
}

/// The welcome or About, when one of them has the focus.
pub fn small_in_front<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    [WELCOME, ABOUT]
        .into_iter()
        .filter_map(|label| app.get_webview_window(label))
        .find(|window| window.is_focused().unwrap_or(false))
}

fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(main) = app.get_webview_window(MAIN) {
        let _ = main.show();
        let _ = main.set_focus();
    }
}

/// Shows the welcome at the first launch, and at a later one that finds no
/// agent on the PATH, in place of the main window; the main window shows
/// otherwise. Looking runs no program, but it waits on the login shell's
/// environment, so it runs aside while the main window loads unseen.
pub fn at_launch<R: Runtime>(app: &AppHandle<R>) {
    let due = chord_core::api::home_directory()
        .as_deref()
        .is_some_and(chord_core::setup::welcome_due);
    if due {
        open_welcome(app, false);
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        if chord_core::setup::agent_on_path() {
            show_main(&app);
        } else {
            open_welcome(&app, true);
        }
    });
}

/// Closing the welcome before it is gone through quits the app, and closing
/// the main window closes the small ones with it, so the app ends then too.
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if !matches!(event, WindowEvent::Destroyed) {
        return;
    }
    let app = window.app_handle();
    match window.label() {
        WELCOME if !main_shown(app) => crate::leaving::quit(app),
        MAIN => {
            for label in [WELCOME, ABOUT] {
                if let Some(small) = app.get_webview_window(label) {
                    let _ = small.close();
                }
            }
        }
        _ => {}
    }
}

/// The welcome is gone through: it is noted as seen, and the main window
/// takes its place. With `motion`, on macOS, the two windows cross-fade:
/// the welcome fades out over the first part while the main window fades
/// in. Elsewhere, and without motion, they swap at once.
#[tauri::command]
pub async fn welcome_continue(app: AppHandle, motion: Option<bool>) {
    if let Some(home) = chord_core::api::home_directory() {
        chord_core::setup::welcome_seen(&home);
    }
    #[cfg(target_os = "macos")]
    if motion.unwrap_or(false) {
        if let Some(welcome) = app.get_webview_window(WELCOME) {
            cross_fade(&app, welcome);
            return;
        }
    }
    let _ = motion;
    show_main(&app);
    if let Some(welcome) = app.get_webview_window(WELCOME) {
        let _ = welcome.close();
    }
}

/// How long the welcome takes to fade out, and the main window to fade in.
#[cfg(target_os = "macos")]
const FADE_OUT: std::time::Duration = std::time::Duration::from_millis(150);
#[cfg(target_os = "macos")]
const FADE_IN: std::time::Duration = std::time::Duration::from_millis(400);

/// Fades the welcome out and the main window in, then closes the welcome.
/// A main window already showing stays as it is.
#[cfg(target_os = "macos")]
fn cross_fade(app: &AppHandle, welcome: WebviewWindow) {
    let main = app.get_webview_window(MAIN);
    let fade_main = main.as_ref().filter(|_| !main_shown(app)).cloned();
    if let Some(main) = &fade_main {
        let shown = main.clone();
        let _ = main.run_on_main_thread(move || {
            set_alpha(&shown, 0.0);
            let _ = shown.show();
            let _ = shown.set_focus();
        });
    } else if let Some(main) = &main {
        let _ = main.set_focus();
    }
    std::thread::spawn(move || {
        let started = std::time::Instant::now();
        loop {
            let t = started.elapsed();
            let out = (t.as_secs_f64() / FADE_OUT.as_secs_f64()).min(1.0);
            let into = (t.as_secs_f64() / FADE_IN.as_secs_f64()).min(1.0);
            let (welcome_step, main_step) = (welcome.clone(), fade_main.clone());
            let _ = welcome.run_on_main_thread(move || {
                set_alpha(&welcome_step, 1.0 - out);
                if let Some(main) = &main_step {
                    set_alpha(main, into * (2.0 - into));
                }
            });
            if into >= 1.0 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(16));
        }
        let _ = welcome.close();
    });
}

/// Sets how opaque a window is, from 0 to 1. Runs on the main thread.
#[cfg(target_os = "macos")]
fn set_alpha(window: &WebviewWindow, alpha: f64) {
    if let Ok(pointer) = window.ns_window() {
        // The pointer is the window's own NSWindow, alive while the window is.
        let window = unsafe { &*(pointer as *const objc2_app_kit::NSWindow) };
        window.setAlphaValue(alpha);
    }
}

/// Opens the welcome over the main window. The window commands are async:
/// a window built from a synchronous one blocks on Windows.
#[tauri::command]
pub async fn welcome_show(app: AppHandle) {
    open_welcome(&app, false);
}

/// Opens About.
#[tauri::command]
pub async fn about_open(app: AppHandle) {
    open_about(&app);
}

/// The app's version, the commit it was built from, the system with its
/// version, and the processor, which About shows and copies for an issue.
#[tauri::command]
pub fn about_info(app: AppHandle) -> serde_json::Value {
    let os = match std::env::consts::OS {
        "macos" => "macOS",
        "windows" => "Windows",
        "linux" => "Linux",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        other => other,
    };
    serde_json::json!({
        "version": app.package_info().version.to_string(),
        "commit": option_env!("CHORD_COMMIT").filter(|commit| !commit.is_empty()),
        "os": os,
        "osVersion": chord_core::setup::system_version(),
        "arch": arch,
    })
}
