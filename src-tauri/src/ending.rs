//! The end of the app with sessions still running.
//!
//! Every integrated session is stopped before the process exits, which
//! takes as long as the sessions need to end: seconds when an agent keeps
//! going until it is asked twice. That wait is never spent on the main
//! thread, which draws the windows. When the app is asked to exit and a
//! session is running, the windows and the Dock icon go at once, the
//! sessions are stopped on a thread of their own with the grace periods
//! they always had, and the exit goes on when the last one is gone. The
//! process lives until then, so no agent outlives it, and the lock that
//! keeps a second copy of the app out is held until then.
//!
//! Another request to exit while this goes on is dropped, not kept for
//! later.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Manager};

/// Takes every window and, on macOS, the Dock icon off the screen. The
/// process goes on until the sessions are gone.
pub fn vanish(app: &AppHandle) {
    for window in app.webview_windows().values() {
        let _ = window.hide();
    }
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
}

/// How long the sessions are given to stop before the app exits anyway:
/// the longest the stop itself waits, and a margin.
pub const CEILING: Duration = Duration::from_secs(15);

/// Whether the app is being ended, with its sessions not yet gone.
pub fn under_way(app: &AppHandle) -> bool {
    app.try_state::<Ending>()
        .is_some_and(|ending| ending.under_way())
}

/// How far the end of the app has come.
#[derive(Default)]
pub struct Ending {
    /// The sessions are being stopped.
    begun: AtomicBool,
    /// The sessions are gone and the exit may go through.
    stopped: Arc<AtomicBool>,
}

impl Ending {
    /// Whether the app is being ended, with the sessions not yet gone.
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    pub fn under_way(&self) -> bool {
        self.begun.load(Ordering::SeqCst) && !self.stopped.load(Ordering::SeqCst)
    }

    /// A request to exit has come. Returns whether the exit is to be held
    /// back: when sessions are running and the stop is not done, or when
    /// the stop is under way. `hide` takes the app off the screen. `stop`
    /// stops the sessions on a thread of its own, and `exit` exits once it
    /// has returned or panicked, or once `ceiling` has passed, whichever
    /// comes first, so the app never lives on without a window. `hide` is
    /// called at most once and `exit` at most once.
    pub fn exit_requested(
        &self,
        running: bool,
        ceiling: Duration,
        hide: impl FnOnce(),
        stop: impl FnOnce() + Send + 'static,
        exit: impl FnOnce() + Send + 'static,
    ) -> bool {
        if self.stopped.load(Ordering::SeqCst) {
            return false;
        }
        if self.begun.swap(true, Ordering::SeqCst) {
            return true;
        }
        if !running {
            self.stopped.store(true, Ordering::SeqCst);
            return false;
        }
        hide();
        let finish = Arc::new(Finish {
            stopped: Arc::clone(&self.stopped),
            exit: Mutex::new(Some(Box::new(exit))),
        });
        let watchdog = Arc::clone(&finish);
        std::thread::spawn(move || {
            std::thread::sleep(ceiling);
            watchdog.run();
        });
        std::thread::spawn(move || {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(stop));
            finish.run();
        });
        true
    }
}

/// The exit, which happens once, from whichever thread gets there first.
struct Finish {
    stopped: Arc<AtomicBool>,
    exit: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl Finish {
    fn run(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        let exit = self.exit.lock().ok().and_then(|mut exit| exit.take());
        if let Some(exit) = exit {
            exit();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    const LONG: Duration = Duration::from_secs(60);

    fn never() {
        panic!("called");
    }

    #[test]
    fn nothing_running_lets_the_exit_through() {
        let ending = Ending::default();
        assert!(!ending.exit_requested(false, LONG, never, never, never));
        assert!(!ending.under_way());
    }

    #[test]
    fn running_sessions_hold_the_exit_while_the_app_goes_away_and_the_stop_runs_apart() {
        let ending = Ending::default();
        let (hid, was_hidden) = mpsc::channel();
        let (release, released) = mpsc::channel::<()>();
        let (done, exited) = mpsc::channel();
        let started = std::time::Instant::now();
        let held = ending.exit_requested(
            true,
            LONG,
            move || hid.send(()).unwrap(),
            move || {
                released.recv().unwrap();
            },
            move || done.send(()).unwrap(),
        );
        assert!(held);
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "the stop is not waited for"
        );
        was_hidden
            .try_recv()
            .expect("hidden before the stop is done");
        assert!(ending.under_way());
        assert!(exited.try_recv().is_err(), "no exit while the stop runs");
        release.send(()).unwrap();
        exited
            .recv_timeout(Duration::from_secs(5))
            .expect("exits once stopped");
        assert!(!ending.under_way());
        assert!(!ending.exit_requested(true, LONG, never, never, never));
    }

    #[test]
    fn another_request_while_the_stop_runs_is_dropped_not_kept() {
        let ending = Ending::default();
        let (release, released) = mpsc::channel::<()>();
        let (done, exited) = mpsc::channel();
        assert!(ending.exit_requested(
            true,
            LONG,
            || {},
            move || {
                released.recv().unwrap();
            },
            move || done.send(()).unwrap(),
        ));
        for _ in 0..3 {
            assert!(ending.exit_requested(true, LONG, never, never, never));
        }
        release.send(()).unwrap();
        exited.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(
            exited.recv_timeout(Duration::from_millis(200)).is_err(),
            "one exit only"
        );
    }

    #[test]
    fn a_stop_that_panics_still_ends_in_an_exit() {
        let ending = Ending::default();
        let (done, exited) = mpsc::channel();
        assert!(ending.exit_requested(
            true,
            LONG,
            || {},
            || panic!("a session wedged"),
            move || done.send(()).unwrap(),
        ));
        exited
            .recv_timeout(Duration::from_secs(5))
            .expect("exits after the panic");
    }

    #[test]
    fn a_stop_that_outlasts_the_ceiling_is_exited_over_once() {
        let ending = Ending::default();
        let (done, exited) = mpsc::channel();
        assert!(ending.exit_requested(
            true,
            Duration::from_millis(100),
            || {},
            || std::thread::sleep(Duration::from_millis(600)),
            move || done.send(()).unwrap(),
        ));
        exited
            .recv_timeout(Duration::from_secs(5))
            .expect("exits at the ceiling");
        assert!(!ending.under_way());
        assert!(
            exited.recv_timeout(Duration::from_secs(1)).is_err(),
            "the late stop does not exit again"
        );
    }
}
