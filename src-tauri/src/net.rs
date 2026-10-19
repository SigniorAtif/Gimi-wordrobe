//! Network fetches (optional, SPEC §1): the hash index update. Kept out of `core` because it does I/O over HTTP.

use crate::core::error::{AppError, AppResult};
use crate::core::fsutil;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn humanizes_like_the_build_script() {
        assert_eq!(humanize("TomeofEternalFlow"), "Tome of the Eternal Flow");
        assert_eq!(humanize("SkywardBlade"), "Skyward Blade");
        assert_eq!(humanize("FischlHighness"), "Fischl Highness");
        assert_eq!(humanize("AmosBow"), "Amos Bow");
    }
}
