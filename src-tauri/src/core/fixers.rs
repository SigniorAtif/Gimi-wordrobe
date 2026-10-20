//! Fixer scripts (Settings › Fixer scripts): tools the user downloaded themselves, such as the ORFix Applier or
//! "Fix All Character Mods", run in order on every newly added skin. They run in the freshly extracted copy, before
//! the scan, so the scan sees the hashes they update. The app ships none of them.

use super::model::FixerScript;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// Longest a single script may run before it's stopped.
pub const TIMEOUT: Duration = Duration::from_secs(300);

/// Script types the Settings picker offers.
pub const EXTENSIONS: &[&str] = &["exe", "bat", "cmd", "py", "ps1"];

/// The community tools wait for Enter before and after they work; enough of them to get past every prompt.
const ANSWERS: usize = 64;

#[derive(Debug, Default, Clone, PartialEq)]
pub struct FixerOutcome {
    /// Scripts that ran and exited cleanly.
    pub ran: usize,
    /// One line per script that was skipped or failed.
    pub warnings: Vec<String>,
}

impl FixerOutcome {
    /// One line for the toast after an add; None when no script ran.
    pub fn note(&self) -> Option<String> {
        match self.ran {
            0 => None,
            1 => Some("Ran 1 fixer script on the new skin.".into()),
            n => Some(format!("Ran {n} fixer scripts on the new skin.")),
        }
    }
}

/// Run every enabled script, in order, with `dir` as the working folder. A failing script is reported and the rest
/// still run; the add goes on either way.
pub fn run_all(scripts: &[FixerScript], dir: &Path, timeout: Duration, progress: &mut dyn FnMut(&str)) -> FixerOutcome {
    let mut out = FixerOutcome::default();
    for s in scripts.iter().filter(|s| s.enabled && !s.path.trim().is_empty()) {
        let path = Path::new(s.path.trim());
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| s.path.clone());
        progress(&format!("Running {name}"));
        match run_one(path, dir, timeout) {
            Ok(()) => out.ran += 1,
            Err(e) => out.warnings.push(format!("Fixer script {name} {e}. The skin was added without it.")),
        }
    }
    out
}

/// The ways to start a script, tried in order until one exists (Python has two launchers).
fn commands_for(script: &Path) -> Result<Vec<Command>, String> {
    let ext = script.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let with = |program: &str, before: &[&str]| {
        let mut c = Command::new(program);
        c.args(before).arg(script);
        c
    };
    Ok(match ext.as_str() {
        // std runs .bat/.cmd through cmd.exe with safe quoting
        "exe" | "bat" | "cmd" => vec![Command::new(script)],
        "py" => vec![with("py", &["-3"]), with("python", &[]), with("python3", &[])],
        "ps1" => vec![with("powershell", &["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])],
        #[cfg(unix)]
        "sh" => vec![with("sh", &[])],
        _ => return Err(format!("isn't a type the app can run (.{ext})")),
    })
}

fn run_one(script: &Path, dir: &Path, timeout: Duration) -> Result<(), String> {
    if !script.is_file() {
        return Err("wasn't found (moved or deleted?)".into());
    }
    for mut cmd in commands_for(script)? {
        cmd.current_dir(dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // a file name the console code page can't print would crash a Python script mid-way
            .env("PYTHONIOENCODING", "utf-8:replace");
        hide_window(&mut cmd);
        match cmd.spawn() {
            Ok(child) => return wait(child, timeout),
            // that launcher isn't installed: try the next one
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(format!("couldn't start ({e})")),
        }
    }
    if script.extension().is_some_and(|e| e.eq_ignore_ascii_case("py")) {
        Err("needs Python, which isn't installed (the tool's .exe works without it)".into())
    } else {
        Err("couldn't start".into())
    }
}

/// Feed it the Enter presses, collect its output, and stop it if it runs too long.
fn wait(mut child: Child, timeout: Duration) -> Result<(), String> {
    if let Some(mut stdin) = child.stdin.take() {
        std::thread::spawn(move || {
            // a script that never reads closes the pipe; that's fine
            let _ = stdin.write_all("\n".repeat(ANSWERS).as_bytes());
        });
    }
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    for pipe in [
        child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>),
        child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut pipe = pipe;
            let mut buf = vec![];
            let _ = pipe.read_to_end(&mut buf);
            let _ = tx.send(buf);
        });
    }
    drop(tx);
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if start.elapsed() >= timeout => {
                kill_tree(&mut child);
                return Err(format!("took longer than {} seconds and was stopped", timeout.as_secs()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(format!("couldn't be watched ({e})")),
        }
    };
    if status.success() {
        return Ok(());
    }
    // a helper process it left behind can hold the pipes open, so don't wait long for the output
    let mut output = String::new();
    while let Ok(b) = rx.recv_timeout(Duration::from_secs(2)) {
        output.push_str(&String::from_utf8_lossy(&b));
    }
    let last = output.lines().map(str::trim).rfind(|l| !l.is_empty()).map(|l| {
        let l: String = l.chars().take(160).collect();
        format!(": {l}")
    });
    let code = status.code().map(|c| format!(" with code {c}")).unwrap_or_default();
    Err(format!("failed (exited{code}{})", last.unwrap_or_default()))
}

#[cfg(windows)]
fn hide_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_window(_: &mut Command) {}

/// Stop the script and anything it started (a .bat's programs, a packed .exe's real process).
fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        let mut c = Command::new("taskkill");
        c.args(["/PID", &child.id().to_string(), "/T", "/F"]).stdout(Stdio::null()).stderr(Stdio::null());
        hide_window(&mut c);
        let _ = c.status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn script(dir: &Path, name: &str, body: &str) -> FixerScript {
        let p = dir.join(name);
        fs::write(&p, body).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
        }
        FixerScript { path: p.to_string_lossy().into_owned(), enabled: true }
    }

    /// A script that appends `tag` to log.txt in the folder it runs in, after waiting for Enter like the real tools.
    fn appender(dir: &Path, name: &str, tag: &str) -> FixerScript {
        #[cfg(windows)]
        return script(dir, &format!("{name}.cmd"), &format!("@echo off\r\nset /p x=\r\necho {tag}>>log.txt\r\n"));
        #[cfg(unix)]
        return script(dir, &format!("{name}.sh"), &format!("#!/bin/sh\nread x\necho {tag} >> log.txt\n"));
    }

    fn failing(dir: &Path) -> FixerScript {
        #[cfg(windows)]
        return script(dir, "bad.cmd", "@echo off\r\necho broke here 1>&2\r\nexit /b 3\r\n");
        #[cfg(unix)]
        return script(dir, "bad.sh", "#!/bin/sh\necho broke here >&2\nexit 3\n");
    }

    fn log(dir: &Path) -> Vec<String> {
        fs::read_to_string(dir.join("log.txt")).unwrap_or_default().lines().map(|l| l.trim().to_string()).collect()
    }

    #[test]
    fn runs_enabled_scripts_in_order_in_the_mod_folder() {
        let tools = tempfile::tempdir().unwrap();
        let skin = tempfile::tempdir().unwrap();
        let mut off = appender(tools.path(), "off", "off");
        off.enabled = false;
        let list = vec![appender(tools.path(), "first", "one"), off, appender(tools.path(), "second", "two")];
        let mut labels = vec![];
        let out = run_all(&list, skin.path(), TIMEOUT, &mut |l| labels.push(l.to_string()));
        assert_eq!(log(skin.path()), vec!["one", "two"]);
        assert_eq!(out.ran, 2);
        assert!(out.warnings.is_empty(), "{:?}", out.warnings);
        assert_eq!(labels.len(), 2);
        assert_eq!(out.note().as_deref(), Some("Ran 2 fixer scripts on the new skin."));
        assert!(!tools.path().join("log.txt").exists(), "runs in the skin's folder, not the script's");
    }

    #[test]
    fn a_failing_or_missing_script_is_reported_and_the_rest_still_run() {
        let tools = tempfile::tempdir().unwrap();
        let skin = tempfile::tempdir().unwrap();
        let gone = FixerScript { path: tools.path().join("gone.exe").to_string_lossy().into_owned(), enabled: true };
        let list = vec![failing(tools.path()), gone, appender(tools.path(), "ok", "ok")];
        let out = run_all(&list, skin.path(), TIMEOUT, &mut |_| {});
        assert_eq!(log(skin.path()), vec!["ok"]);
        assert_eq!(out.ran, 1);
        assert_eq!(out.warnings.len(), 2, "{:?}", out.warnings);
        assert!(out.warnings[0].contains("exited with code 3: broke here"), "{}", out.warnings[0]);
        assert!(out.warnings[1].contains("gone.exe wasn't found"), "{}", out.warnings[1]);
    }

    #[test]
    fn a_script_that_hangs_is_stopped() {
        let tools = tempfile::tempdir().unwrap();
        let skin = tempfile::tempdir().unwrap();
        #[cfg(windows)]
        let s = script(tools.path(), "hang.cmd", "@echo off\r\nping -n 30 127.0.0.1 >nul\r\n");
        #[cfg(unix)]
        let s = script(tools.path(), "hang.sh", "#!/bin/sh\nsleep 30\n");
        let start = Instant::now();
        let out = run_all(&[s], skin.path(), Duration::from_secs(1), &mut |_| {});
        assert!(start.elapsed() < Duration::from_secs(15));
        assert_eq!(out.ran, 0);
        assert!(out.warnings[0].contains("was stopped"), "{:?}", out.warnings);
    }

    #[test]
    fn unknown_types_are_refused() {
        let tools = tempfile::tempdir().unwrap();
        let s = script(tools.path(), "notes.txt", "hi");
        let out = run_all(&[s], tools.path(), TIMEOUT, &mut |_| {});
        assert!(out.warnings[0].contains("isn't a type the app can run (.txt)"), "{:?}", out.warnings);
    }
}
