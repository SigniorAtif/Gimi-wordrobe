//! Network fetches (optional, SPEC §1): the hash index update and GameBanana previews. Kept out of `core` because
//! it does I/O over HTTP; `core::previews` checks and stores what arrives.

use crate::core::error::{AppError, AppResult};
use crate::core::fsutil;
use crate::core::previews::{
    GameBananaInfo, MAX_GB_IMAGES, MAX_IMAGE_BYTES, allowed_image_url, gamebanana_mod_id, image_ext, parse_profile,
    profile_url, too_many,
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const REPO: &str = "SilentNightSound/GI-Model-Importer-Assets";
const UA: &str = "skin-switcher (+https://github.com/SigniorAtif/Gimi-wordrobe)";

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(30))).build().into()
}

fn get_json(agent: &ureq::Agent, url: &str) -> AppResult<Value> {
    let mut last = String::new();
    for attempt in 0..3 {
        match agent.get(url).header("User-Agent", UA).call() {
            Ok(mut res) => {
                return res.body_mut().read_json::<Value>().map_err(|e| AppError::new("network", e.to_string()));
            }
            Err(e) => {
                last = e.to_string();
                std::thread::sleep(Duration::from_millis(400 * (attempt + 1)));
            }
        }
    }
    Err(AppError::new("network", format!("Couldn't reach GitHub: {last}")))
}

/// Same spellings as scripts/build-hash-index.mjs (our own overrides, not upstream data).
fn humanize(key: &str) -> String {
    let overrides = [
        ("TomeofEternalFlow", "Tome of the Eternal Flow"),
        ("KaedeharaKazuha", "Kazuha"),
        ("HuTao", "Hu Tao"),
        ("YaeMiko", "Yae Miko"),
        ("RaidenShogun", "Raiden Shogun"),
        ("KamisatoAyaka", "Kamisato Ayaka"),
        ("KamisatoAyato", "Kamisato Ayato"),
        ("KujouSara", "Kujou Sara"),
        ("KukiShinobu", "Kuki Shinobu"),
        ("ShikanoinHeizou", "Shikanoin Heizou"),
        ("YunJin", "Yun Jin"),
        ("XianYun", "Xianyun"),
    ];
    if let Some((_, v)) = overrides.iter().find(|(k, _)| *k == key) {
        return v.to_string();
    }
    let mut out = String::new();
    let chars: Vec<char> = key.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        if i > 0
            && ((c.is_uppercase() && chars[i - 1].is_lowercase())
                || (c.is_ascii_digit() && chars[i - 1].is_alphabetic()))
        {
            out.push(' ');
        }
        out.push(c);
    }
    out.split(' ')
        .map(|w| if w.len() > 4 && w.ends_with("of") { format!("{} of", &w[..w.len() - 2]) } else { w.to_string() })
        .collect::<Vec<_>>()
        .join(" ")
}

fn group_of(top: &str) -> Option<&'static str> {
    Some(match top {
        "PlayerCharacterData" => "character",
        "WeaponData" => "weapon",
        "NPCData" => "npc",
        "EnemyData" => "enemy",
        "MiscellaneousData" => "misc",
        "SkillData" => "skill",
        _ => return None,
    })
}

/// Fetch the latest GI-Model-Importer-Assets data and write a fresh hash index to `dest` (SPEC §5).
pub fn update_hash_index(dest: &Path) -> AppResult<(Option<String>, usize)> {
    let agent = agent();
    let commit = get_json(&agent, &format!("https://api.github.com/repos/{REPO}/commits/main"))?;
    let sha =
        commit["sha"].as_str().ok_or_else(|| AppError::new("network", "Unexpected reply from GitHub."))?.to_string();
    let date = commit["commit"]["committer"]["date"].as_str().map(|d| d.chars().take(10).collect::<String>());
    let tree = get_json(&agent, &format!("https://api.github.com/repos/{REPO}/git/trees/{sha}?recursive=1"))?;
    let paths: Vec<String> = tree["tree"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|t| t["path"].as_str())
                .filter(|p| p.ends_with("/hash.json"))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let paths: Vec<String> =
        paths.into_iter().filter(|p| group_of(p.split('/').next().unwrap_or("")).is_some()).collect();
    if paths.is_empty() {
        return Err(AppError::new("network", "No hash data found upstream."));
    }

    // fetch with a few workers
    let queue = Arc::new(Mutex::new(paths.clone().into_iter().enumerate().collect::<Vec<_>>()));
    let results: Arc<Mutex<BTreeMap<usize, Value>>> = Arc::new(Mutex::new(BTreeMap::new()));
    let workers: Vec<_> = (0..8)
        .map(|_| {
            let (q, r, a, sha) = (queue.clone(), results.clone(), agent.clone(), sha.clone());
            std::thread::spawn(move || {
                while let Some((i, p)) = q.lock().ok().and_then(|mut q| q.pop()) {
                    let url = format!("https://raw.githubusercontent.com/{REPO}/{sha}/{}", p.replace(' ', "%20"));
                    if let Ok(v) = get_json(&a, &url)
                        && let Ok(mut r) = r.lock()
                    {
                        r.insert(i, v);
                    }
                }
            })
        })
        .collect();
    for w in workers {
        let _ = w.join();
    }
    let results = Arc::try_unwrap(results).map(|m| m.into_inner().unwrap_or_default()).unwrap_or_default();
    if results.len() != paths.len() {
        // all or nothing: a partial index (newer date) would replace the fuller bundled one
        return Err(AppError::new(
            "network",
            format!(
                "{} of {} hash files failed to download; kept the current index.",
                paths.len() - results.len(),
                paths.len()
            ),
        ));
    }

    let char_keys: BTreeSet<String> = paths
        .iter()
        .filter(|p| p.starts_with("PlayerCharacterData/"))
        .filter_map(|p| p.rsplit('/').nth(1).map(str::to_string))
        .collect();
    let mut entities = vec![];
    let mut hashes: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for (i, p) in paths.iter().enumerate() {
        let Some(data) = results.get(&i) else {
            continue;
        };
        let parts: Vec<&str> = p.split('/').collect();
        let key = parts[parts.len() - 2].to_string();
        let group = group_of(parts[0]).unwrap_or("misc");
        let mut base: Option<String> = None;
        if group == "character" {
            for c in &char_keys {
                if c != &key
                    && key.starts_with(c.as_str())
                    && key[c.len()..].starts_with(|ch: char| ch.is_uppercase())
                    && base.as_ref().map(|b| c.len() > b.len()).unwrap_or(true)
                {
                    base = Some(c.clone());
                }
            }
        }
        if group == "npc" && key != "Paimon" && key.starts_with("Paimon") {
            base = Some("Paimon".into());
        }
        let idx = entities.len();
        entities.push(json!({ "key": key, "name": humanize(&key), "group": group, "base": base, "path": parts[..parts.len() - 1].join("/") }));
        let comps: Vec<&Value> = match data {
            Value::Array(a) => a.iter().collect(),
            Value::Object(o) => o.values().collect(),
            _ => vec![],
        };
        let mut add = |h: &str, comp: &str, part: &str| {
            let h = h.trim().to_ascii_lowercase();
            if h.len() == 8 && h.chars().all(|c| c.is_ascii_hexdigit()) {
                hashes.entry(h).or_default().push(json!([idx, comp, part]));
            }
        };
        for c in comps {
            let part = c["component_name"].as_str().unwrap_or("");
            for f in ["ib", "position_vb", "blend_vb", "texcoord_vb", "draw_vb"] {
                if let Some(h) = c[f].as_str() {
                    add(h, f, part);
                }
            }
            for set in c["texture_hashes"].as_array().into_iter().flatten() {
                for t in set.as_array().into_iter().flatten() {
                    if let (Some(kind), Some(h)) = (t[0].as_str(), t[2].as_str()) {
                        add(h, &format!("texture:{kind}"), part);
                    }
                }
            }
        }
    }
    if entities.is_empty() {
        return Err(AppError::new("network", "Couldn't download the hash data."));
    }
    let count = hashes.len();
    let out =
        json!({ "version": 1, "source": REPO, "commit": sha, "date": date, "entities": entities, "hashes": hashes });
    fsutil::write_json_atomic(dest, &out, false)?;
    Ok((date, count))
}

/// GameBanana (SPEC §10). Statuses come back as responses so GameBanana's own error message ("This Mod doesn't
/// exist") reaches the user. Image downloads never follow redirects, so nothing but images.gamebanana.com is ever
/// contacted for them.
fn gb_agent(redirects: u32) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(20)))
        .http_status_as_error(false)
        .max_redirects(redirects)
        .build()
        .into()
}

fn gb_failure(e: impl std::fmt::Display) -> AppError {
    AppError::new("network", format!("Couldn't reach GameBanana ({e}). Check the connection and retry."))
}

/// Read a mod's ProfilePage: name, author, NSFW hint and preview image URLs.
pub fn gamebanana_info(url: &str) -> AppResult<GameBananaInfo> {
    let id = gamebanana_mod_id(url)
        .ok_or_else(|| AppError::new("bad_link", "That isn't a GameBanana mod link (gamebanana.com/mods/…)."))?;
    let mut res = gb_agent(2).get(&profile_url(id)).header("User-Agent", UA).call().map_err(gb_failure)?;
    let status = res.status().as_u16();
    let body: Value = res.body_mut().with_config().limit(8 * 1024 * 1024).read_json().map_err(|e| {
        if status == 200 {
            AppError::new("gamebanana", format!("GameBanana sent an unreadable answer: {e}"))
        } else {
            gb_failure(format!("HTTP {status}"))
        }
    })?;
    // a 404 still carries `_sErrorMessage`; parse_profile turns it into the message shown
    parse_profile(id, &body)
}

/// Download one preview image: GameBanana's image host only, capped in size, and it has to be a real image.
pub fn download_image(url: &str) -> AppResult<Vec<u8>> {
    if !allowed_image_url(url) {
        return Err(AppError::new("bad_image_url", "Only images from images.gamebanana.com are downloaded."));
    }
    let mut res = gb_agent(0).get(url).header("User-Agent", UA).call().map_err(gb_failure)?;
    let status = res.status().as_u16();
    if status != 200 {
        return Err(gb_failure(format!("HTTP {status}")));
    }
    let bytes = res.body_mut().with_config().limit(MAX_IMAGE_BYTES).read_to_vec().map_err(gb_failure)?;
    if image_ext(&bytes).is_none() {
        return Err(AppError::new("not_an_image", "GameBanana sent something that isn't a PNG, JPG or WebP image."));
    }
    Ok(bytes)
}

/// A mod's info plus its downloaded images. A failed image is skipped (counted), not fatal, unless all fail.
pub struct GameBananaFetch {
    pub info: GameBananaInfo,
    pub images: Vec<Vec<u8>>,
    pub failed: usize,
}

/// Most GameBanana images downloaded at the same time (each can be up to 25 MB in memory).
const PARALLEL_DOWNLOADS: usize = 3;

/// Run `fetch` over `urls` with at most [`PARALLEL_DOWNLOADS`] at once. Results come back in the order of `urls`.
fn download_all<F>(urls: &[String], fetch: F) -> Vec<AppResult<Vec<u8>>>
where
    F: Fn(&str) -> AppResult<Vec<u8>> + Sync,
{
    let next = AtomicUsize::new(0);
    let (next, fetch) = (&next, &fetch);
    let done: Vec<(usize, AppResult<Vec<u8>>)> = std::thread::scope(|s| {
        let workers: Vec<_> = (0..PARALLEL_DOWNLOADS.min(urls.len()))
            .map(|_| {
                s.spawn(move || {
                    let mut out = vec![];
                    loop {
                        let i = next.fetch_add(1, Ordering::Relaxed);
                        let Some(u) = urls.get(i) else { break };
                        out.push((i, fetch(u)));
                    }
                    out
                })
            })
            .collect();
        workers.into_iter().flat_map(|w| w.join().unwrap_or_default()).collect()
    });
    let mut results: Vec<Option<AppResult<Vec<u8>>>> = urls.iter().map(|_| None).collect();
    for (i, r) in done {
        results[i] = Some(r);
    }
    // a worker that panicked lost its results: those images count as failed
    results.into_iter().map(|r| r.unwrap_or_else(|| Err(gb_failure("download thread failed")))).collect()
}

/// Read the mod's page, then download at most `room` of its images (never more than 12): the skin can't take more,
/// so fetching them would only waste memory and bandwidth. A full skin (`room` 0) is refused before any request.
pub fn fetch_gamebanana(url: &str, room: usize) -> AppResult<GameBananaFetch> {
    let want = room.min(MAX_GB_IMAGES);
    if want == 0 {
        return Err(too_many());
    }
    let info = gamebanana_info(url)?;
    let urls: Vec<String> = info.images.iter().take(want).cloned().collect();
    let results = download_all(&urls, download_image);
    let mut images = vec![];
    let mut failed = 0;
    for r in results {
        match r {
            Ok(b) => images.push(b),
            Err(_) => failed += 1,
        }
    }
    if images.is_empty() && failed > 0 {
        return Err(AppError::new("network", "Couldn't download the previews from GameBanana. Retry in a moment."));
    }
    Ok(GameBananaFetch { info, images, failed })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downloads_three_at_a_time_in_order() {
        let urls: Vec<String> = (0..8).map(|i| format!("https://images.gamebanana.com/{i}.png")).collect();
        let (now, peak) = (AtomicUsize::new(0), AtomicUsize::new(0));
        let results = download_all(&urls, |u| {
            let n = now.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(n, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(15));
            now.fetch_sub(1, Ordering::SeqCst);
            if u.ends_with("/5.png") { Err(gb_failure("HTTP 404")) } else { Ok(u.as_bytes().to_vec()) }
        });
        let peak = peak.load(Ordering::SeqCst);
        assert!(peak > 1 && peak <= PARALLEL_DOWNLOADS, "{peak} at once");
        assert_eq!(results.len(), urls.len());
        for (i, (r, u)) in results.iter().zip(&urls).enumerate() {
            match r {
                Ok(b) => assert_eq!(b, u.as_bytes(), "GameBanana's order is kept"),
                Err(_) => assert_eq!(i, 5),
            }
        }
        assert!(download_all(&[], |_| Ok(vec![])).is_empty());
    }

    #[test]
    fn a_full_skin_is_refused_before_any_request() {
        // a link that would fail if it were fetched: room 0 never gets that far
        assert_eq!(fetch_gamebanana("https://gamebanana.com/mods/1", 0).err().unwrap().code, "too_many");
    }

    #[test]
    fn humanizes_like_the_build_script() {
        assert_eq!(humanize("TomeofEternalFlow"), "Tome of the Eternal Flow");
        assert_eq!(humanize("SkywardBlade"), "Skyward Blade");
        assert_eq!(humanize("FischlHighness"), "Fischl Highness");
        assert_eq!(humanize("AmosBow"), "Amos Bow");
    }

    /// Live check of the GameBanana shape and download path: `cargo test -- --ignored live_gamebanana`.
    #[test]
    #[ignore = "needs the network"]
    fn live_gamebanana() {
        let f = fetch_gamebanana("https://gamebanana.com/mods/729570", 30).unwrap();
        assert!(!f.info.name.is_empty());
        assert!(f.info.author.is_some());
        assert!(!f.images.is_empty(), "{:?}", f.info.images);
        assert!(f.images.iter().all(|b| image_ext(b).is_some()));
        let missing = gamebanana_info("https://gamebanana.com/mods/999999999").unwrap_err();
        assert_eq!(missing.code, "gamebanana", "{missing:?}");
        println!("{} by {:?}: {} images, {} failed", f.info.name, f.info.author, f.images.len(), f.failed);
    }
}
