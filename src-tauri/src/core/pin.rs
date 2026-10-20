//! PIN lock for revealing NSFW skins (SPEC §6 Settings, §11). A soft lock, not encryption: it keeps a casual
//! onlooker from pressing Ctrl+H. The PIN is stored in settings.json as an Argon2id PHC string with a random salt,
//! never in the snapshot the UI receives, and wrong guesses are throttled.

use super::app::AppCore;
use super::error::{AppError, AppResult};
use super::model::Snapshot;
use super::settings;
use argon2::Argon2;
use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use serde::Serialize;
use std::time::{Duration, Instant};

/// Wrong guesses allowed before the first lockout.
pub const FREE_TRIES: u32 = 5;
const FIRST_LOCK: Duration = Duration::from_secs(30);
const MAX_LOCK: Duration = Duration::from_secs(10 * 60);

/// 4 to 6 digits (SPEC §6).
pub fn valid(pin: &str) -> bool {
    (4..=6).contains(&pin.len()) && pin.bytes().all(|b| b.is_ascii_digit())
}

pub fn hash(pin: &str) -> AppResult<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(pin.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| AppError::new("pin_hash", format!("Couldn't store the PIN: {e}")))
}

/// Constant-time check against a stored PHC string; an unreadable hash never matches.
pub fn verify(pin: &str, stored: &str) -> bool {
    PasswordHash::new(stored).is_ok_and(|h| Argon2::default().verify_password(pin.as_bytes(), &h).is_ok())
}

/// Wrong-PIN throttle: FREE_TRIES guesses, then a lockout that doubles with every further miss (30 s, 1 min, 2 min…,
/// capped at 10 min). In memory only, so restarting the app resets it; fine for a soft lock.
#[derive(Debug, Default)]
pub struct Throttle {
    failures: u32,
    until: Option<Instant>,
}

impl Throttle {
    /// Time left before another guess is accepted.
    pub fn wait(&self, now: Instant) -> Option<Duration> {
        self.until.and_then(|u| u.checked_duration_since(now)).filter(|d| !d.is_zero())
    }

    pub fn fail(&mut self, now: Instant) {
        self.failures += 1;
        if self.failures >= FREE_TRIES {
            let doublings = (self.failures - FREE_TRIES).min(10);
            self.until = Some(now + (FIRST_LOCK * 2u32.pow(doublings)).min(MAX_LOCK));
        }
    }

    pub fn reset(&mut self) {
        *self = Throttle::default();
    }

    pub fn tries_left(&self) -> u32 {
        FREE_TRIES.saturating_sub(self.failures)
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PinCheck {
    pub ok: bool,
    /// Seconds until another guess is accepted (0 = now).
    pub retry_in: u64,
    /// Guesses left before a lockout.
    pub tries_left: u32,
}

impl AppCore {
    /// A stored hash that can't be read (truncated or hand-edited) counts as no PIN: otherwise the 18+ reveal and
    /// the PIN itself would be locked behind a PIN nobody can enter. It's a soft lock, so that's the right side to fail.
    pub fn pin_set(&self) -> bool {
        self.stored_pin().is_some()
    }

    fn stored_pin(&self) -> Option<String> {
        // whole: it parses and carries a full-length digest, as `hash` writes it
        let whole = |h: &String| {
            PasswordHash::new(h).is_ok_and(|p| p.hash.is_some_and(|o| o.len() == argon2::Params::DEFAULT_OUTPUT_LEN))
        };
        self.settings.nsfw.pin_hash.clone().filter(whole)
    }

    /// Check a PIN before revealing NSFW skins. With no PIN set, anything passes.
    pub fn verify_pin(&mut self, pin: &str) -> PinCheck {
        self.check_pin_at(pin, Instant::now())
    }

    pub(super) fn check_pin_at(&mut self, pin: &str, now: Instant) -> PinCheck {
        let Some(stored) = self.stored_pin() else {
            return PinCheck { ok: true, retry_in: 0, tries_left: FREE_TRIES };
        };
        if let Some(wait) = self.pin_throttle.wait(now) {
            return PinCheck { ok: false, retry_in: wait.as_secs().max(1), tries_left: 0 };
        }
        if verify(pin, &stored) {
            self.pin_throttle.reset();
            return PinCheck { ok: true, retry_in: 0, tries_left: FREE_TRIES };
        }
        self.pin_throttle.fail(now);
        PinCheck {
            ok: false,
            retry_in: self.pin_throttle.wait(now).map_or(0, |d| d.as_secs().max(1)),
            tries_left: self.pin_throttle.tries_left(),
        }
    }

    /// Set, change (`next`) or remove (`None`) the PIN. Changing or removing an existing PIN needs the current one.
    pub fn set_pin(&mut self, current: Option<&str>, next: Option<&str>) -> AppResult<Snapshot> {
        if self.pin_set() {
            let check = self.verify_pin(current.unwrap_or_default());
            if !check.ok {
                return Err(wrong_pin(&check));
            }
        }
        let pin_hash = match next {
            Some(p) if !valid(p) => return Err(AppError::new("pin_invalid", "Use 4 to 6 digits for the PIN.")),
            Some(p) => Some(hash(p)?),
            None => None,
        };
        let mut next_settings = self.settings.clone();
        next_settings.nsfw.pin_hash = pin_hash;
        settings::save(self.config_dir(), &next_settings)?;
        self.settings = next_settings;
        Ok(self.publish())
    }
}

fn wrong_pin(c: &PinCheck) -> AppError {
    if c.retry_in > 0 {
        AppError::new("pin_locked", format!("Too many wrong PINs. Try again in {} s.", c.retry_in))
    } else {
        AppError::new("pin_wrong", "That's not the current PIN.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::model::WhenHidden;

    #[test]
    fn pins_are_4_to_6_digits() {
        assert!(valid("1234") && valid("123456"));
        assert!(!valid("123") && !valid("1234567") && !valid("12a4") && !valid("١٢٣٤") && !valid(""));
    }

    #[test]
    fn hashes_are_salted_and_verify() {
        let a = hash("2580").unwrap();
        let b = hash("2580").unwrap();
        assert_ne!(a, b, "a random salt makes every hash different");
        assert!(a.starts_with("$argon2id$"));
        assert!(!a.contains("2580"));
        assert!(verify("2580", &a) && verify("2580", &b));
        assert!(!verify("2581", &a));
        assert!(!verify("2580", "salt$deadbeef"), "an unreadable hash never matches");
    }

    #[test]
    fn throttle_locks_after_free_tries_and_doubles() {
        let t0 = Instant::now();
        let mut t = Throttle::default();
        for i in 0..FREE_TRIES - 1 {
            t.fail(t0);
            assert_eq!(t.wait(t0), None, "try {i} is still free");
        }
        t.fail(t0);
        assert_eq!(t.wait(t0), Some(FIRST_LOCK));
        assert_eq!(t.wait(t0 + FIRST_LOCK), None);
        t.fail(t0 + FIRST_LOCK);
        assert_eq!(t.wait(t0 + FIRST_LOCK), Some(FIRST_LOCK * 2));
        for _ in 0..20 {
            t.fail(t0);
        }
        assert_eq!(t.wait(t0), Some(MAX_LOCK));
        t.reset();
        assert_eq!((t.wait(t0), t.tries_left()), (None, FREE_TRIES));
    }

    #[test]
    fn an_unreadable_stored_hash_counts_as_no_pin() {
        let dir = tempfile::tempdir().unwrap();
        let mut core = AppCore::open(dir.path());
        let full = hash("2580").unwrap();
        for bad in ["", "salt$deadbeef", "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ", &full[..full.len() - 6]] {
            core.settings.nsfw.pin_hash = Some(bad.to_string());
            assert!(!core.pin_set(), "{bad:?}");
        }
        core.settings.nsfw.pin_hash = Some(full.clone());
        assert!(core.pin_set(), "a whole hash is a PIN");
        core.settings.nsfw.pin_hash = Some(full[..full.len() - 6].to_string());
        assert!(core.verify_pin("0000").ok, "reveal isn't locked behind a PIN nobody can enter");
        assert!(core.set_pin(None, Some("2580")).unwrap().pin_set, "and a new PIN can be set");
    }

    #[test]
    fn set_change_remove_and_never_leak_the_hash() {
        let dir = tempfile::tempdir().unwrap();
        let mut core = AppCore::open(dir.path());
        assert!(core.verify_pin("0000").ok, "no PIN set: reveal is free");

        let snap = core.set_pin(None, Some("2580")).unwrap();
        assert!(snap.pin_set);
        let json = serde_json::to_string(&snap).unwrap();
        assert!(!json.contains("argon2") && !json.contains("pinHash"), "the UI never sees the hash");
        let saved = std::fs::read_to_string(settings::path(dir.path())).unwrap();
        assert!(saved.contains("$argon2id$") && !saved.contains("\"2580\""));

        assert!(!core.verify_pin("1111").ok);
        assert!(core.verify_pin("2580").ok);
        assert_eq!(core.set_pin(Some("1111"), Some("9999")).unwrap_err().code, "pin_wrong");
        for bad in ["99", "1234567", "12a4", ""] {
            assert_eq!(core.set_pin(Some("2580"), Some(bad)).unwrap_err().code, "pin_invalid", "{bad:?}");
        }
        assert!(core.verify_pin("2580").ok, "a refused change keeps the old PIN");

        // setting the same PIN again stores a fresh salt, so the hash on disk changes
        let stored = |core: &AppCore| core.settings().nsfw.pin_hash.clone().unwrap();
        let before = stored(&core);
        core.set_pin(Some("2580"), Some("2580")).unwrap();
        assert_ne!(stored(&core), before);
        assert!(core.verify_pin("2580").ok);

        core.set_pin(Some("2580"), Some("9999")).unwrap();
        assert!(core.verify_pin("9999").ok);

        // a fresh start reads the hash back from settings.json
        let mut again = AppCore::open(dir.path());
        assert!(again.pin_set() && again.verify_pin("9999").ok && !again.verify_pin("2580").ok);

        let snap = core.set_pin(Some("9999"), None).unwrap();
        assert!(!snap.pin_set && core.verify_pin("").ok);
    }

    #[test]
    fn wrong_guesses_lock_reveal_and_pin_changes() {
        let dir = tempfile::tempdir().unwrap();
        let mut core = AppCore::open(dir.path());
        core.set_pin(None, Some("2580")).unwrap();
        let t0 = Instant::now();
        for left in (0..FREE_TRIES).rev() {
            let c = core.check_pin_at("0000", t0);
            assert_eq!((c.ok, c.tries_left), (false, left));
        }
        // locked: even the right PIN waits
        let c = core.check_pin_at("2580", t0);
        assert_eq!((c.ok, c.retry_in), (false, 30));
        assert_eq!(core.set_pin(Some("2580"), None).unwrap_err().code, "pin_locked");
        assert!(core.check_pin_at("2580", t0 + FIRST_LOCK).ok);
    }

    #[test]
    fn saving_settings_keeps_the_pin() {
        let dir = tempfile::tempdir().unwrap();
        let mut core = AppCore::open(dir.path());
        core.set_pin(None, Some("2580")).unwrap();
        // the UI sends settings back without the hash (it never had it); that must not remove the PIN
        let mut from_ui = core.snapshot().settings;
        from_ui.nsfw.pin_hash = None;
        from_ui.nsfw.auto_rehide = false;
        from_ui.nsfw.when_hidden = WhenHidden::Invisible;
        from_ui.nsfw.hotkey = "Alt+Shift+N".into();
        core.save_settings(from_ui).unwrap();
        assert!(core.pin_set() && core.verify_pin("2580").ok);
        assert!(!core.settings().nsfw.auto_rehide);

        // and all of it survives a restart
        let mut again = AppCore::open(dir.path());
        let nsfw = &again.settings().nsfw;
        assert_eq!(
            (nsfw.hotkey.as_str(), nsfw.when_hidden, nsfw.auto_rehide),
            ("Alt+Shift+N", WhenHidden::Invisible, false)
        );
        assert!(again.snapshot().pin_set && again.verify_pin("2580").ok);
    }
}
