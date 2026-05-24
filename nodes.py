from __future__ import annotations

import json
import random
import re
from pathlib import Path
from typing import Any

from aiohttp import web
from server import PromptServer


BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data"
TAG_FILE = DATA_DIR / "anima_artists.txt"
PREF_FILE = DATA_DIR / "preferences.json"


def ensure_data_dir() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def normalize_tag(value: Any) -> str:
    if value is None:
        return ""

    tag = str(value).strip()
    if not tag:
        return ""

    tag = tag.replace("\u00a0", " ")
    tag = re.sub(r"\s+", "_", tag)

    if not tag.startswith("@"):
        tag = "@" + tag

    tag = tag.lower()
    tag = re.sub(r"@+", "@", tag)
    return tag


def normalize_query(value: Any) -> str:
    tag = normalize_tag(value)
    return tag[1:] if tag.startswith("@") else tag


def dedupe_preserve_order(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


def load_tags() -> list[str]:
    if not TAG_FILE.exists():
        return []

    tags: list[str] = []
    with TAG_FILE.open("r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            tag = normalize_tag(line)
            if tag:
                tags.append(tag)

    return dedupe_preserve_order(tags)


def load_preferences() -> dict[str, list[str]]:
    ensure_data_dir()

    if not PREF_FILE.exists():
        return {"favorites": [], "blacklist": []}

    try:
        with PREF_FILE.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return {"favorites": [], "blacklist": []}

    favorites = [normalize_tag(t) for t in data.get("favorites", [])]
    blacklist = [normalize_tag(t) for t in data.get("blacklist", [])]

    favorites = [t for t in dedupe_preserve_order(favorites) if t]
    blacklist = [t for t in dedupe_preserve_order(blacklist) if t]

    favorites = [t for t in favorites if t not in blacklist]

    return {
        "favorites": favorites,
        "blacklist": blacklist,
    }


def save_preferences(prefs: dict[str, list[str]]) -> None:
    ensure_data_dir()

    favorites = [normalize_tag(t) for t in prefs.get("favorites", []) if normalize_tag(t)]
    blacklist = [normalize_tag(t) for t in prefs.get("blacklist", []) if normalize_tag(t)]

    cleaned = {
        "favorites": dedupe_preserve_order(favorites),
        "blacklist": dedupe_preserve_order(blacklist),
    }

    cleaned["favorites"] = [t for t in cleaned["favorites"] if t not in cleaned["blacklist"]]

    with PREF_FILE.open("w", encoding="utf-8") as f:
        json.dump(cleaned, f, indent=2, ensure_ascii=False, sort_keys=True)


def allowed_tags(all_tags: list[str], prefs: dict[str, list[str]], respect_blacklist: bool = True) -> list[str]:
    if not respect_blacklist:
        return all_tags[:]

    blacklist = set(prefs.get("blacklist", []))
    return [t for t in all_tags if t not in blacklist]


def allowed_favorites(all_tags: list[str], prefs: dict[str, list[str]], respect_blacklist: bool = True) -> list[str]:
    favorites = prefs.get("favorites", [])
    if respect_blacklist:
        blacklist = set(prefs.get("blacklist", []))
        return [t for t in favorites if t not in blacklist]
    return favorites[:]


def pick_random_tag(pool: list[str]) -> str:
    return random.choice(pool) if pool else ""


def pick_random_favorite(
    all_tags: list[str],
    prefs: dict[str, list[str]],
    respect_blacklist: bool = True,
) -> str:
    favs = allowed_favorites(all_tags, prefs, respect_blacklist=respect_blacklist)
    if favs:
        return random.choice(favs)

    pool = allowed_tags(all_tags, prefs, respect_blacklist=respect_blacklist)
    return pick_random_tag(pool)


def sanitize_filename_part(text: str) -> str:
    text = normalize_tag(text)
    if text.startswith("@"):
        text = text[1:]
    text = text.replace("/", "_").replace("\\", "_")
    text = re.sub(r"[^a-zA-Z0-9_.-]+", "_", text)
    text = re.sub(r"_+", "_", text).strip("._-")
    return text or "comfyui"


def filename_from_prompt(prompt: str, max_words: int = 5) -> str:
    """
    Fallback filename when no artist is chosen.
    Example:
      "absurdres, masterpiece, best quality, very aesthetic, 1girl"
      -> "absurdres_masterpiece_best_quality_very_aesthetic_comfyui"
    """
    text = prompt or ""
    text = re.sub(r"@[A-Za-z0-9_.\-]+", " ", text)
    text = text.replace("__ANIMA_ARTIST__", " ")
    text = re.sub(r"[^A-Za-z0-9]+", " ", text).strip()
    words = text.split()
    if not words:
        return "comfyui"
    return "_".join(words[:max_words]).lower() + "_comfyui"


def extract_explicit_artist_from_prompt(prompt: str) -> str:
    """
    Pull the first real artist tag from the prompt itself.
    Ignores @random and @fav/@favorite.
    """
    if not prompt:
        return ""

    matches = re.findall(r"(?<!\w)@([A-Za-z0-9_.\-]+)", prompt)
    for m in matches:
        tag = normalize_tag("@" + m)
        if tag not in ("@random", "@fav", "@favorite"):
            return tag
    return ""


async def read_json(request) -> dict[str, Any]:
    try:
        data = await request.json()
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    return {}


routes = PromptServer.instance.routes


@routes.get("/anima_artists")
async def anima_artists(request):
    query = request.rel_url.query.get("q", "").strip()
    include_blacklisted = request.rel_url.query.get("include_blacklisted", "0").lower() in ("1", "true", "yes")

    tags = load_tags()
    prefs = load_preferences()

    if not include_blacklisted:
        tags = allowed_tags(tags, prefs, respect_blacklist=True)

    if query:
        q = normalize_query(query)
        tags = [t for t in tags if q in t.lstrip("@")]

    return web.json_response(
        {
            "tags": tags[:50],
            "favorites": prefs["favorites"],
            "blacklist": prefs["blacklist"],
        }
    )


@routes.get("/anima_state")
async def anima_state(request):
    tags = load_tags()
    prefs = load_preferences()

    return web.json_response(
        {
            "tag_count": len(tags),
            "favorites": prefs["favorites"],
            "blacklist": prefs["blacklist"],
        }
    )


@routes.post("/anima_toggle_favorite")
async def anima_toggle_favorite(request):
    data = await read_json(request)
    tag = normalize_tag(data.get("tag", ""))

    if not tag:
        return web.json_response({"ok": False, "error": "Missing tag"}, status=400)

    prefs = load_preferences()

    favorites = set(prefs["favorites"])
    blacklist = set(prefs["blacklist"])

    if tag in favorites:
        favorites.remove(tag)
    else:
        favorites.add(tag)
        blacklist.discard(tag)

    prefs["favorites"] = sorted(favorites)
    prefs["blacklist"] = sorted(blacklist)
    save_preferences(prefs)

    return web.json_response(
        {
            "ok": True,
            "favorites": prefs["favorites"],
            "blacklist": prefs["blacklist"],
        }
    )


@routes.post("/anima_toggle_blacklist")
async def anima_toggle_blacklist(request):
    data = await read_json(request)
    tag = normalize_tag(data.get("tag", ""))

    if not tag:
        return web.json_response({"ok": False, "error": "Missing tag"}, status=400)

    prefs = load_preferences()

    favorites = set(prefs["favorites"])
    blacklist = set(prefs["blacklist"])

    if tag in blacklist:
        blacklist.remove(tag)
    else:
        blacklist.add(tag)
        favorites.discard(tag)

    prefs["favorites"] = sorted(favorites)
    prefs["blacklist"] = sorted(blacklist)
    save_preferences(prefs)

    return web.json_response(
        {
            "ok": True,
            "favorites": prefs["favorites"],
            "blacklist": prefs["blacklist"],
        }
    )


class AnimaArtistWildcard:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": "1girl, masterpiece, __ANIMA_ARTIST__",
                    },
                ),
            }
        }

    @classmethod
    def IS_CHANGED(cls, prompt: str):
        return float("NaN")

    RETURN_TYPES = ("STRING", "STRING", "STRING")
    RETURN_NAMES = ("prompt", "selected_artist", "filename_prefix")
    FUNCTION = "run"
    CATEGORY = "Anima"

    def run(self, prompt: str):
        all_tags = load_tags()
        prefs = load_preferences()

        prompt = prompt or ""
        allowed_pool = allowed_tags(all_tags, prefs, respect_blacklist=True)

        def random_allowed() -> str:
            return pick_random_tag(allowed_pool)

        def random_favorite() -> str:
            return pick_random_favorite(all_tags, prefs, respect_blacklist=True)

        picked_events: list[tuple[str, str]] = []

        def replace_random(_match):
            picked = random_allowed()
            picked_events.append(("random", picked))
            return picked

        def replace_fav(_match):
            picked = random_favorite()
            picked_events.append(("fav", picked))
            return picked

        out = re.sub(r"@random\b", replace_random, prompt, flags=re.IGNORECASE)
        out = re.sub(r"@fav(?:orite)?\b", replace_fav, out, flags=re.IGNORECASE)

        explicit_artist = extract_explicit_artist_from_prompt(prompt)

        chosen_artist = ""
        source_kind = ""

        if explicit_artist:
            chosen_artist = explicit_artist
            source_kind = "artist"
        elif picked_events:
            source_kind, chosen_artist = picked_events[0]

        if "__ANIMA_ARTIST__" in out:
            out = out.replace("__ANIMA_ARTIST__", chosen_artist or "")

        selected_artist = chosen_artist or ""

        if selected_artist:
            filename_prefix = f"{sanitize_filename_part(selected_artist)}_comfyui"
        else:
            filename_prefix = "ComfyUI"

        return (out, selected_artist, filename_prefix)


NODE_CLASS_MAPPINGS = {
    "AnimaArtistWildcard": AnimaArtistWildcard,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AnimaArtistWildcard": "Artist Helper",
}
