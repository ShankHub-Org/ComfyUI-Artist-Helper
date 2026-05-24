import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const SHOW_BLACKLISTED = true;
const SHOW_SPECIAL_SHORTCUTS = true;

function debounce(fn, wait = 120) {
    let timer = null;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), wait);
    };
}

async function fetchTags(query) {
    try {
        const url = `/anima_artists?q=${encodeURIComponent(query)}&include_blacklisted=1`;
        const res = await api.fetchApi(url);
        if (!res.ok) return [];
        const data = await res.json();
        return Array.isArray(data.tags) ? data.tags : [];
    } catch (err) {
        console.error("Anima autocomplete: fetchTags failed", err);
        return [];
    }
}

async function fetchState() {
    try {
        const res = await api.fetchApi("/anima_state");
        if (!res.ok) return { favorites: [], blacklist: [] };
        const data = await res.json();
        return {
            favorites: Array.isArray(data.favorites) ? data.favorites : [],
            blacklist: Array.isArray(data.blacklist) ? data.blacklist : [],
        };
    } catch (err) {
        console.error("Anima autocomplete: fetchState failed", err);
        return { favorites: [], blacklist: [] };
    }
}

async function toggleFavorite(tag) {
    try {
        const res = await api.fetchApi("/anima_toggle_favorite", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tag }),
        });
        return res.ok;
    } catch (err) {
        console.error("Anima autocomplete: toggleFavorite failed", err);
        return false;
    }
}

async function toggleBlacklist(tag) {
    try {
        const res = await api.fetchApi("/anima_toggle_blacklist", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tag }),
        });
        return res.ok;
    } catch (err) {
        console.error("Anima autocomplete: toggleBlacklist failed", err);
        return false;
    }
}

function getQueryAtCursor(textarea) {
    const text = textarea.value;
    const pos = textarea.selectionStart ?? text.length;
    const before = text.slice(0, pos);

    // Treat commas/newlines/brackets as separators, but not spaces.
    // This keeps the popup alive after typing a space.
    const lastSep = Math.max(
        before.lastIndexOf("\n"),
        before.lastIndexOf(","),
        before.lastIndexOf("("),
        before.lastIndexOf("["),
        before.lastIndexOf("{")
    );

    const at = before.lastIndexOf("@");
    if (at === -1 || at < lastSep) return null;

    const raw = before.slice(at, pos).trimEnd();
    if (!raw.startsWith("@")) return null;

    return {
        query: raw.slice(1),
        start: at,
        end: pos,
    };
}

function getCaretCoordinates(textarea) {
    const selectionStart = textarea.selectionStart ?? 0;
    const style = window.getComputedStyle(textarea);

    const mirror = document.createElement("div");
    const span = document.createElement("span");

    const props = [
        "boxSizing",
        "width",
        "height",
        "overflowX",
        "overflowY",
        "borderTopWidth",
        "borderRightWidth",
        "borderBottomWidth",
        "borderLeftWidth",
        "paddingTop",
        "paddingRight",
        "paddingBottom",
        "paddingLeft",
        "fontStyle",
        "fontVariant",
        "fontWeight",
        "fontStretch",
        "fontSize",
        "lineHeight",
        "fontFamily",
        "letterSpacing",
        "textTransform",
        "textAlign",
        "textIndent",
        "textDecoration",
        "wordSpacing",
        "tabSize",
        "MozTabSize",
        "whiteSpace",
        "direction",
    ];

    props.forEach((prop) => {
        mirror.style[prop] = style[prop];
    });

    mirror.style.position = "absolute";
    mirror.style.visibility = "hidden";
    mirror.style.whiteSpace = "pre-wrap";
    mirror.style.wordWrap = "break-word";
    mirror.style.left = "-9999px";
    mirror.style.top = "0";
    mirror.style.overflow = "hidden";

    const before = textarea.value.slice(0, selectionStart);
    mirror.textContent = before;

    span.textContent = "\u200b";
    mirror.appendChild(span);

    document.body.appendChild(mirror);

    const mirrorRect = mirror.getBoundingClientRect();
    const spanRect = span.getBoundingClientRect();
    const textareaRect = textarea.getBoundingClientRect();

    const x = textareaRect.left + (spanRect.left - mirrorRect.left) - textarea.scrollLeft;
    const y = textareaRect.top + (spanRect.top - mirrorRect.top) - textarea.scrollTop;

    document.body.removeChild(mirror);

    return {
        x,
        y,
        height: spanRect.height || parseFloat(style.lineHeight) || 18,
    };
}

app.registerExtension({
    name: "comfyui.anima.main_prompt_autocomplete",

    async setup() {
        try {
            const popup = document.createElement("div");
            popup.style.position = "fixed";
            popup.style.zIndex = "999999";
            popup.style.display = "none";
            popup.style.minWidth = "260px";
            popup.style.maxWidth = "420px";
            popup.style.maxHeight = "260px";
            popup.style.overflowY = "auto";
            popup.style.background = "#1e1e1e";
            popup.style.border = "1px solid #444";
            popup.style.borderRadius = "8px";
            popup.style.boxShadow = "0 10px 30px rgba(0,0,0,0.35)";
            popup.style.padding = "4px";
            popup.style.color = "#fff";
            popup.style.pointerEvents = "auto";
            document.body.appendChild(popup);

            let activeTextarea = null;
            let activeItems = [];
            let activeIndex = -1;
            let favorites = new Set();
            let blacklist = new Set();
            let lastFetchId = 0;
            let rafPending = false;

            function hidePopup() {
                popup.style.display = "none";
                popup.innerHTML = "";
                activeItems = [];
                activeIndex = -1;
            }

            function setActiveIndex(newIndex) {
                activeIndex = newIndex;
                const rows = popup.querySelectorAll("[data-row='1']");
                rows.forEach((row, i) => {
                    row.style.background = i === activeIndex ? "#3a3a3a" : row.dataset.baseBg || "#1e1e1e";
                });
            }

            function schedulePosition() {
                if (rafPending) return;
                rafPending = true;
                requestAnimationFrame(() => {
                    rafPending = false;
                    positionPopup();
                });
            }

            function positionPopup() {
                if (!activeTextarea || popup.style.display === "none") return;

                const caret = getCaretCoordinates(activeTextarea);
                const popupWidth = 420;
                const popupHeight = popup.getBoundingClientRect().height || 180;

                let left = caret.x;
                let top = caret.y + caret.height + 8;

                if (left + popupWidth > window.innerWidth - 10) {
                    left = Math.max(10, window.innerWidth - popupWidth - 10);
                }

                if (top + popupHeight > window.innerHeight - 10) {
                    top = Math.max(10, caret.y - popupHeight - 10);
                }

                popup.style.left = `${left}px`;
                popup.style.top = `${top}px`;
            }

            function isSpecialItem(tag) {
                const t = tag.toLowerCase();
                return t === "@random" || t === "@fav" || t === "@favorite";
            }

            function getItemStyle(tag) {
                const t = tag.toLowerCase();

                if (t === "@random") {
                    return {
                        color: "#66aaff",
                        border: "1px solid rgba(102,170,255,0.35)",
                        textDecoration: "none",
                        opacity: "1",
                    };
                }

                if (t === "@fav" || t === "@favorite") {
                    return {
                        color: "#63e6a6",
                        border: "1px solid rgba(99,230,166,0.35)",
                        textDecoration: "none",
                        opacity: "1",
                    };
                }

                if (blacklist.has(t)) {
                    return {
                        color: "#ff7a7a",
                        border: "1px solid rgba(255,122,122,0.35)",
                        textDecoration: "line-through",
                        opacity: "0.85",
                    };
                }

                if (favorites.has(t)) {
                    return {
                        color: "#63e6a6",
                        border: "1px solid rgba(99,230,166,0.25)",
                        textDecoration: "none",
                        opacity: "1",
                    };
                }

                return {
                    color: "#fff",
                    border: "1px solid #444",
                    textDecoration: "none",
                    opacity: "1",
                };
            }

            function insertTag(textarea, tagInfo) {
                const info = getQueryAtCursor(textarea);
                if (!info) return;

                const tag = tagInfo.startsWith("@") ? tagInfo : `@${tagInfo}`;
                const before = textarea.value.slice(0, info.start);
                const after = textarea.value.slice(info.end);

                textarea.value = `${before}${tag}, ${after}`;
                const cursor = before.length + tag.length + 2;

                textarea.focus();
                textarea.setSelectionRange(cursor, cursor);
                textarea.dispatchEvent(new Event("input", { bubbles: true }));

                hidePopup();
            }

            function buildSuggestionList(query, tags) {
                const q = query.toLowerCase().trim();
                const items = [];

                if (SHOW_SPECIAL_SHORTCUTS) {
                    if (!q || "random".startsWith(q) || "@random".includes(`@${q}`)) {
                        items.push("@random");
                    }
                    if (!q || "fav".startsWith(q) || "favorite".startsWith(q) || "@fav".includes(`@${q}`) || "@favorite".includes(`@${q}`)) {
                        items.push("@fav");
                    }
                }

                items.push(...tags);

                const seen = new Set();
                const deduped = [];
                for (const item of items) {
                    const key = item.toLowerCase();
                    if (seen.has(key)) continue;
                    seen.add(key);
                    deduped.push(item);
                }

                if (!SHOW_BLACKLISTED) {
                    return deduped.filter((item) => !blacklist.has(item.toLowerCase()));
                }

                return deduped;
            }

            async function renderSuggestions(query, tags, textarea) {
                popup.innerHTML = "";
                activeItems = buildSuggestionList(query, tags).slice(0, 15);

                if (!activeItems.length) {
                    hidePopup();
                    return;
                }

                for (let idx = 0; idx < activeItems.length; idx++) {
                    const tag = activeItems[idx];
                    const lower = tag.toLowerCase();
                    const style = getItemStyle(tag);

                    const row = document.createElement("div");
                    row.dataset.row = "1";
                    row.dataset.baseBg = "#1e1e1e";
                    row.style.display = "flex";
                    row.style.alignItems = "center";
                    row.style.gap = "6px";
                    row.style.width = "100%";
                    row.style.margin = "0 0 4px 0";
                    row.style.padding = "4px";
                    row.style.borderRadius = "6px";
                    row.style.background = idx === 0 ? "#3a3a3a" : "#1e1e1e";

                    const textButton = document.createElement("button");
                    textButton.type = "button";
                    textButton.textContent = tag;
                    textButton.style.flex = "1";
                    textButton.style.textAlign = "left";
                    textButton.style.padding = "6px 8px";
                    textButton.style.margin = "0";
                    textButton.style.borderRadius = "6px";
                    textButton.style.cursor = "pointer";
                    textButton.style.fontSize = "13px";
                    textButton.style.color = style.color;
                    textButton.style.background = "transparent";
                    textButton.style.border = style.border;
                    textButton.style.textDecoration = style.textDecoration;
                    textButton.style.opacity = style.opacity;

                    textButton.addEventListener("mousedown", (e) => {
                        e.preventDefault();
                        insertTag(textarea, tag);
                    });

                    row.appendChild(textButton);

                    if (!isSpecialItem(tag)) {
                        const starBtn = document.createElement("button");
                        starBtn.type = "button";
                        starBtn.textContent = favorites.has(lower) ? "★" : "☆";
                        starBtn.title = favorites.has(lower) ? "Remove from favorites" : "Add to favorites";
                        starBtn.style.width = "28px";
                        starBtn.style.height = "28px";
                        starBtn.style.borderRadius = "6px";
                        starBtn.style.border = "1px solid rgba(99,230,166,0.35)";
                        starBtn.style.cursor = "pointer";
                        starBtn.style.background = favorites.has(lower) ? "rgba(99,230,166,0.15)" : "#222";
                        starBtn.style.color = "#63e6a6";
                        starBtn.style.fontSize = "14px";
                        starBtn.style.lineHeight = "1";

                        starBtn.addEventListener("mousedown", async (e) => {
                            e.preventDefault();
                            const ok = await toggleFavorite(tag);
                            if (ok) {
                                const state = await fetchState();
                                favorites = new Set((state.favorites || []).map((t) => t.toLowerCase()));
                                blacklist = new Set((state.blacklist || []).map((t) => t.toLowerCase()));
                                await renderSuggestions(query, tags, textarea);
                                schedulePosition();
                            }
                        });

                        const crossBtn = document.createElement("button");
                        crossBtn.type = "button";
                        crossBtn.textContent = "×";
                        crossBtn.title = blacklist.has(lower) ? "Remove from blacklist" : "Add to blacklist";
                        crossBtn.style.width = "28px";
                        crossBtn.style.height = "28px";
                        crossBtn.style.borderRadius = "6px";
                        crossBtn.style.border = "1px solid rgba(255,122,122,0.35)";
                        crossBtn.style.cursor = "pointer";
                        crossBtn.style.background = blacklist.has(lower) ? "rgba(255,122,122,0.15)" : "#222";
                        crossBtn.style.color = "#ff7a7a";
                        crossBtn.style.fontSize = "16px";
                        crossBtn.style.lineHeight = "1";

                        crossBtn.addEventListener("mousedown", async (e) => {
                            e.preventDefault();
                            const ok = await toggleBlacklist(tag);
                            if (ok) {
                                const state = await fetchState();
                                favorites = new Set((state.favorites || []).map((t) => t.toLowerCase()));
                                blacklist = new Set((state.blacklist || []).map((t) => t.toLowerCase()));
                                await renderSuggestions(query, tags, textarea);
                                schedulePosition();
                            }
                        });

                        row.appendChild(starBtn);
                        row.appendChild(crossBtn);
                    }

                    popup.appendChild(row);
                }

                activeIndex = 0;
                popup.style.display = "block";
                setActiveIndex(0);
                schedulePosition();
            }

            const refresh = debounce(async () => {
                if (!activeTextarea || document.activeElement !== activeTextarea) {
                    hidePopup();
                    return;
                }

                const info = getQueryAtCursor(activeTextarea);
                if (!info) {
                    hidePopup();
                    return;
                }

                const query = info.query.replace(/^@/, "");
                const fetchId = ++lastFetchId;

                const [state, tags] = await Promise.all([
                    fetchState(),
                    fetchTags(query),
                ]);

                if (fetchId !== lastFetchId) return;

                favorites = new Set((state.favorites || []).map((t) => t.toLowerCase()));
                blacklist = new Set((state.blacklist || []).map((t) => t.toLowerCase()));

                await renderSuggestions(query, tags, activeTextarea);
            }, 120);

            function bindTextarea(textarea) {
                if (!textarea || textarea.dataset.animaAutocompleteBound === "1") return;
                textarea.dataset.animaAutocompleteBound = "1";

                textarea.addEventListener("focus", () => {
                    activeTextarea = textarea;
                });

                textarea.addEventListener("input", () => {
                    activeTextarea = textarea;
                    refresh();
                });

                textarea.addEventListener("keyup", () => {
                    activeTextarea = textarea;
                    refresh();
                });

                textarea.addEventListener("click", () => {
                    activeTextarea = textarea;
                    refresh();
                });

                textarea.addEventListener("scroll", () => {
                    schedulePosition();
                });

                textarea.addEventListener("blur", () => {
                    setTimeout(() => {
                        if (document.activeElement !== textarea) hidePopup();
                    }, 120);
                });

                textarea.addEventListener("keydown", (e) => {
                    if (popup.style.display === "none") return;

                    if (e.key === "Escape") {
                        e.preventDefault();
                        hidePopup();
                        return;
                    }

                    if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setActiveIndex((activeIndex + 1) % activeItems.length);
                        return;
                    }

                    if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setActiveIndex((activeIndex - 1 + activeItems.length) % activeItems.length);
                        return;
                    }

                    if (e.key === "Enter" || e.key === "Tab") {
                        if (activeIndex >= 0 && activeItems[activeIndex]) {
                            e.preventDefault();
                            insertTag(textarea, activeItems[activeIndex]);
                        }
                    }
                });
            }

            function scanForTextareas() {
                document.querySelectorAll("textarea").forEach(bindTextarea);
                schedulePosition();
            }

            new MutationObserver(() => scanForTextareas()).observe(document.body, {
                childList: true,
                subtree: true,
            });

            window.addEventListener("resize", schedulePosition);
            window.addEventListener("scroll", schedulePosition, true);
            document.addEventListener("selectionchange", () => {
                if (document.activeElement === activeTextarea) schedulePosition();
            });

            scanForTextareas();
        } catch (err) {
            console.error("Anima autocomplete setup failed:", err);
        }
    },
});