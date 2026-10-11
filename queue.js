// Song queue for the Deck in audio.js: add songs from YouTube (a link or a song
// name, downloaded by server.py) or from files, reorder, remove, play one, or
// skip to the next. An AI DJ can fill it for you: Gemini picks songs that fit a
// vibe and what's playing, and a voice (ElevenLabs, or the browser's) introduces
// each one. Plus a floating panel to do all of that.
//
//   const queue = createQueue(deck);
//   const panel = createQueuePanel(queue, deck);
//   queueButton.onclick = () => { deck.ensureContext(); panel.toggle(); };
//
// Call deck.ensureContext() inside clicks before queue actions: browsers only
// allow sound after one. The panel already does this for its own buttons.

const djSongsAhead = 2; // the DJ keeps this many songs queued after the current one
const djPicksPerRequest = 3;
const songEndMargin = 0.3; // seconds before the end at which the DJ moves on
const voiceTimeoutMs = 15000; // never let a stuck voice line stall the set

// Python's dev server sometimes resets the first request on a connection that sat
// idle ("Failed to fetch"). A network error (not an HTTP error) gets one retry.
async function retryOnNetworkError(request) {
  try {
    return await request();
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 300));
    return request();
  }
}

export function createQueue(deck, { apiBase = "/api" } = {}) {
  // Items: { id, title, detail, url } for YouTube, { id, title, detail, file } for files.
  // DJ picks also carry dj: { intro, voiceUrl }.
  let items = [];
  let currentId = null;
  let status = null; // { message, isError } while adding or loading
  let nextId = 1;
  let played = []; // titles in the order they played, for the DJ to avoid repeats
  const dj = { on: false, vibe: "", busy: false, talking: false, status: null, generation: 0 };
  const listeners = new Set();

  const changed = () => {
    listeners.forEach((listener) => listener());
    prefetch(); // the next song may have changed
  };
  function setStatus(message, isError = false) {
    status = message ? { message, isError } : null;
    changed();
  }
  function setDjStatus(message, isError = false) {
    dj.status = message ? { message, isError } : null;
    changed();
  }

  async function postJson(path, body) {
    const response = await retryOnNetworkError(() =>
      fetch(`${apiBase}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    if (response.status === 501) throw new Error("start the app with `python server.py` to use this");
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `request failed (${response.status})`);
    return data;
  }

  // The first song added plays right away, like loading one did before.
  function add(item, { autoplay = true } = {}) {
    const entry = { id: nextId++, ...item };
    items = [...items, entry];
    changed();
    if (autoplay && currentId === null) queue.play(entry.id);
    return entry;
  }

  const upcoming = () => items.slice(items.findIndex((item) => item.id === currentId) + 1);

  // Decoding a song into raw audio takes about 3 s, so the current song and the
  // next one are kept decoded: Next (or the DJ moving on) starts instantly. Only
  // those two, since a decoded song is about 100 MB.
  const decoded = new Map(); // item id -> Promise<AudioBuffer>
  let fallbackDecoder = null;
  let loadingId = null; // the song being loaded right now, kept even if it's no longer current or next

  function decode(item) {
    if (!decoded.has(item.id)) {
      const promise = retryOnNetworkError(async () => {
        let data;
        if (item.url) {
          const response = await fetch(item.url);
          if (!response.ok) throw new Error(`could not fetch audio (${response.status})`);
          data = await response.arrayBuffer();
        } else {
          data = await item.file.arrayBuffer();
        }
        // Before the first click there's no audio context yet; an offline one can still decode.
        fallbackDecoder ??= new OfflineAudioContext(2, 1, 48000);
        return (deck.ctx ?? fallbackDecoder).decodeAudioData(data);
      });
      promise.catch(() => decoded.delete(item.id));
      decoded.set(item.id, promise);
    }
    return decoded.get(item.id);
  }

  // Decodes the current and next song ahead of time, and frees any others.
  function prefetch() {
    const current = items.find((item) => item.id === currentId);
    const wanted = [current, upcoming()[0]].filter(Boolean);
    wanted.forEach(decode);
    const keep = new Set(wanted.map((item) => item.id));
    for (const id of decoded.keys()) if (!keep.has(id) && id !== loadingId) decoded.delete(id);
  }

  // Song loads run one at a time and only the newest request plays: the Deck can't
  // cancel a load, so a slow older one finishing late would replace a newer song.
  let playRequest = 0;
  let playChain = Promise.resolve();

  // While the DJ is introducing a song or switching to it: the flag, and which song.
  let transitioning = false;
  let transitionId = null;

  // ---- AI DJ ----------------------------------------------------------------------

  // The ElevenLabs clip for a DJ line, or null to fall back to the browser's voice.
  async function prepareVoice(text) {
    if (!text) return null;
    try {
      return (await postJson("/dj/voice", { text })).file;
    } catch (error) {
      console.warn("DJ voice unavailable, using the browser voice:", error.message);
      return null;
    }
  }

  // Plays a DJ line and resolves when it's done (or after a timeout).
  function speak(item) {
    const intro = item.dj?.intro;
    if (!intro) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, voiceTimeoutMs);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      if (item.dj.voiceUrl) {
        const audio = new Audio(item.dj.voiceUrl);
        audio.onended = done;
        audio.onerror = done;
        audio.play().catch(done);
      } else if ("speechSynthesis" in window) {
        const line = new SpeechSynthesisUtterance(intro);
        line.onend = done;
        line.onerror = done;
        speechSynthesis.speak(line);
      } else {
        done();
      }
    });
  }

  // Pauses, lets the DJ introduce the song, then plays it. One at a time.
  async function transitionTo(item) {
    transitioning = true;
    transitionId = item.id;
    try {
      dj.talking = Boolean(item.dj?.intro);
      changed();
      if (deck.playing) deck.pause();
      decode(item); // decodes while the DJ talks
      await speak(item);
      dj.talking = false;
      await queue.play(item.id);
    } finally {
      dj.talking = false;
      transitioning = false;
      transitionId = null;
    }
  }

  // Asks the DJ for more songs whenever fewer than djSongsAhead are queued.
  async function topUpDj() {
    if (!dj.on || dj.busy || upcoming().length >= djSongsAhead) return;
    const generation = dj.generation;
    const stillValid = () => dj.on && dj.generation === generation;
    dj.busy = true;
    setDjStatus("Picking songs…");
    let added = 0;
    try {
      const current = items.find((item) => item.id === currentId);
      const { picks } = await postJson("/dj/pick", {
        vibe: dj.vibe,
        nowPlaying: current?.title ?? "",
        queued: items.map((item) => item.title),
        played,
        count: djPicksPerRequest,
      });
      for (const pick of picks) {
        if (!stillValid()) break;
        const label = `${pick.artist} - ${pick.title}`;
        setDjStatus(`Downloading ${label}…`);
        try {
          const song = await postJson("/youtube", { url: label });
          const voiceUrl = await prepareVoice(pick.intro);
          if (!stillValid()) break;
          const entry = add(
            { title: label, detail: `AI DJ · ${pick.reason}`, url: song.file, dj: { intro: pick.intro, voiceUrl } },
            { autoplay: false },
          );
          added += 1;
          if (currentId === null && !transitioning) transitionTo(entry); // nothing playing yet: start the set
        } catch (error) {
          console.warn(`DJ skipped ${label}:`, error.message);
        }
      }
      if (stillValid() && !added) throw new Error("none of the picks could be downloaded");
      setDjStatus(null);
    } catch (error) {
      if (dj.generation === generation) dj.busy = false;
      setDjStatus(`AI DJ: ${error.message}`, true);
      return; // don't retry in a loop; the next song change tries again
    }
    // A newer request (after a vibe change) owns the busy flag now.
    if (dj.generation !== generation) return;
    dj.busy = false;
    changed();
    topUpDj(); // still short because some picks failed? ask again
  }

  // When a song is about to end (or just looped) with the DJ on, move to the next one.
  let lastPhase = 0;
  let lastBuffer = null;
  setInterval(() => {
    if (!dj.on || transitioning || !deck.playing || !deck.buffer) {
      lastPhase = 0;
      return;
    }
    if (deck.buffer !== lastBuffer) {
      lastBuffer = deck.buffer; // a different song started: start watching it fresh
      lastPhase = 0;
    }
    const duration = deck.buffer.duration;
    const phase = deck.position() % duration;
    const ending = phase >= duration - songEndMargin || phase < lastPhase;
    lastPhase = phase;
    const next = upcoming()[0];
    if (!ending || !next) return; // no next song yet: let this one loop
    transitionTo(next);
  }, 200);

  async function loadAndPlay(id) {
    const item = items.find((entry) => entry.id === id);
    if (!item) return;
    if (!decoded.has(id)) setStatus(`Loading ${item.title}…`);
    try {
      loadingId = id;
      const buffer = await decode(item);
      // Same steps as Deck.loadArrayBuffer in audio.js, with the decoding already done.
      deck.ensureContext();
      deck.stopSource();
      deck.buffer = buffer;
      deck.offset = 0;
      deck.play();
      currentId = id;
      if (played.at(-1) !== item.title) played = [...played, item.title].slice(-50);
      setStatus(null);
      topUpDj();
    } catch (error) {
      setStatus(`Error: ${error.message}`, true);
    } finally {
      loadingId = null;
      prefetch();
    }
  }

  // ---- public API -----------------------------------------------------------------

  const queue = {
    getState: () => ({
      items,
      currentId,
      status,
      dj: { on: dj.on, vibe: dj.vibe, busy: dj.busy, talking: dj.talking, status: dj.status },
    }),

    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    // A YouTube link, or plain words to grab the top search result.
    async addYouTube(linkOrSearch) {
      const text = linkOrSearch.trim();
      if (!text) return;
      setStatus(/^https?:\/\//i.test(text) ? "Downloading from YouTube…" : `Searching YouTube for "${text}"…`);
      try {
        const body = await postJson("/youtube", { url: text });
        setStatus(null);
        add({ title: body.title, detail: "YouTube", url: body.file });
      } catch (error) {
        setStatus(`Error: ${error.message}`, true);
      }
    },

    addFile(file) {
      if (!file) return;
      add({ title: file.name.replace(/\.[^.]+$/, ""), detail: "File", file });
    },

    // Moves an item to a new position (0 = top).
    move(id, position) {
      const item = items.find((entry) => entry.id === id);
      if (!item) return;
      const rest = items.filter((entry) => entry.id !== id);
      rest.splice(Math.max(0, Math.min(position, rest.length)), 0, item);
      items = rest;
      changed();
    },

    // Removing the playing song leaves it playing; it's just off the list.
    remove(id) {
      items = items.filter((entry) => entry.id !== id);
      if (currentId === id) currentId = null;
      changed();
      topUpDj();
    },

    play(id) {
      const request = ++playRequest;
      playChain = playChain.then(() => (request === playRequest ? loadAndPlay(id) : undefined));
      return playChain;
    },

    // Plays the song after the current one, wrapping to the top.
    next() {
      if (!items.length) return;
      const position = items.findIndex((entry) => entry.id === currentId);
      queue.play(items[(position + 1) % items.length].id);
    },

    // Turns the AI DJ on: it fills the queue to match the vibe and moves on at the end of each song.
    startDj(vibe = "") {
      dj.on = true;
      dj.vibe = vibe.trim();
      dj.generation += 1;
      setDjStatus(null);
      topUpDj();
    },

    stopDj() {
      dj.on = false;
      dj.generation += 1;
      dj.busy = false;
      setDjStatus(null);
    },

    // New vibe: drops the DJ's not-yet-played picks and picks again.
    changeVibe(vibe) {
      dj.vibe = vibe.trim();
      dj.generation += 1;
      dj.busy = false;
      // Keeps the song the DJ is already introducing.
      const next = new Set(upcoming().filter((item) => item.dj && item.id !== transitionId).map((item) => item.id));
      items = items.filter((item) => !next.has(item.id));
      changed();
      topUpDj();
    },
  };
  return queue;
}

const styles = `
.queuePanel {
  position: fixed; top: 64px; right: 16px; z-index: 50;
  display: flex; flex-direction: column; gap: 10px;
  width: min(440px, calc(100vw - 32px)); max-height: calc(100vh - 80px);
  padding: 14px; border-radius: 14px;
  background: var(--panel); color: var(--text);
  border: 1px solid var(--border); box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55);
}
.queuePanel[hidden] { display: none; }
.queuePanel button { padding: 5px 10px; font-size: 13px; }
.queuePanel-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.queuePanel-header h2 { margin: 0; font-size: 16px; }
.queuePanel-header p { margin: 2px 0 0; font-size: 12px; color: var(--muted); }
.queuePanel-add, .queuePanel-dj { display: flex; gap: 6px; }
.queuePanel-dj { padding: 8px; border-radius: 10px; border: 1px dashed var(--between); }
.queuePanel-dj.on { border-style: solid; }
.queuePanel-djLabel { align-self: center; font-size: 12px; font-weight: 700; color: var(--between); white-space: nowrap; }
.queuePanel-add input[type="text"], .queuePanel-dj input[type="text"] {
  flex: 1; min-width: 0; padding: 7px 10px; font: inherit; font-size: 13px;
  color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
}
.queuePanel-add input[type="file"] { display: none; }
.queuePanel-status { margin: 0; font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.queuePanel-status.error { color: #ff7b7b; }
.queuePanel-list { margin: 0; padding: 0; list-style: none; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
.queuePanel-row {
  display: flex; align-items: center; gap: 8px; padding: 8px; border-radius: 10px; cursor: grab;
  background: var(--bg); border: 1px solid var(--border);
}
.queuePanel-row.current { border-color: var(--between); }
.queuePanel-row.dragging { opacity: 0.35; }
.queuePanel-row.dropBefore { box-shadow: inset 0 3px 0 var(--between); }
.queuePanel-row.dropAfter { box-shadow: inset 0 -3px 0 var(--between); }
.queuePanel-handle { color: var(--muted); letter-spacing: -2px; user-select: none; }
.queuePanel-number { width: 18px; text-align: right; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.queuePanel-track { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.queuePanel-track strong { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.queuePanel-track small { font-size: 11px; color: var(--muted); }
.queuePanel-row.current small { color: var(--between); font-weight: 600; }
.queuePanel-row.fromDj small::before { content: "✦ "; color: var(--between); }
.queuePanel-actions { display: flex; gap: 4px; }
.queuePanel-empty { margin: 0; font-size: 13px; text-align: center; color: var(--muted); }
`;

function element(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === "className") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

// Floating panel for a queue: add (YouTube link, song name or file), drag to
// reorder, ✕ to remove, ▶ to play. Uses the page's CSS variables for colors.
export function createQueuePanel(queue, deck) {
  if (!document.getElementById("queuePanel-styles")) {
    document.head.append(element("style", { id: "queuePanel-styles", text: styles }));
  }
  let draggedId = null;
  let dropIndex = null; // insertion point, 0..items.length

  const input = element("input", { type: "text", placeholder: "YouTube link or song name" });
  const fileInput = element("input", { type: "file", accept: "audio/*,video/mp4" });
  const status = element("p", { className: "queuePanel-status", hidden: "" });
  const vibeInput = element("input", { type: "text", placeholder: "DJ vibe, e.g. chill house into hype EDM" });
  const djButtons = element("span", { className: "queuePanel-actions" });
  const djRow = element("div", { className: "queuePanel-dj" }, [
    element("span", { className: "queuePanel-djLabel", text: "AI DJ" }),
    vibeInput,
    djButtons,
  ]);
  const djStatus = element("p", { className: "queuePanel-status", hidden: "" });
  const list = element("ol", { className: "queuePanel-list" });
  const empty = element("p", { className: "queuePanel-empty", text: "The queue is empty. Add a YouTube link, song name or file." });

  function addFromInput() {
    deck.ensureContext(); // inside the click, so the browser allows sound
    queue.addYouTube(input.value);
    input.value = "";
  }
  input.addEventListener("keydown", (event) => event.key === "Enter" && addFromInput());

  // Start (or, with the DJ on, change the vibe). Inside the click so the DJ's first song can play.
  function startOrChangeVibe() {
    deck.ensureContext();
    if (queue.getState().dj.on) queue.changeVibe(vibeInput.value);
    else queue.startDj(vibeInput.value);
  }
  vibeInput.addEventListener("keydown", (event) => event.key === "Enter" && startOrChangeVibe());
  const startButton = element("button", { type: "button", text: "Start", onClick: startOrChangeVibe });
  const stopButton = element("button", { type: "button", className: "secondary", text: "Stop", onClick: () => queue.stopDj() });
  fileInput.addEventListener("change", () => {
    queue.addFile(fileInput.files[0]);
    fileInput.value = "";
  });
  list.addEventListener("dragleave", (event) => {
    if (!list.contains(event.relatedTarget)) setDropIndex(null);
  });

  const panel = element("section", { className: "queuePanel", role: "dialog", "aria-label": "Queue", hidden: "" }, [
    element("header", { className: "queuePanel-header" }, [
      element("div", {}, [
        element("h2", { text: "Queue" }),
        element("p", { text: "Drag to reorder. ▶ plays a song, Next goes down the list. The AI DJ picks songs for you." }),
      ]),
      element("button", { type: "button", className: "secondary", "aria-label": "Close queue", text: "✕", onClick: () => controls.close() }),
    ]),
    element("div", { className: "queuePanel-add" }, [
      input,
      element("button", { type: "button", text: "Add", onClick: addFromInput }),
      element("button", {
        type: "button",
        className: "secondary",
        text: "File",
        onClick: () => {
          deck.ensureContext();
          fileInput.click();
        },
      }),
      fileInput,
    ]),
    status,
    djRow,
    djStatus,
    list,
    empty,
  ]);
  document.body.append(panel);

  function setDropIndex(index) {
    dropIndex = index;
    const rows = [...list.children];
    rows.forEach((row, position) => {
      row.classList.toggle("dropBefore", index === position);
      row.classList.toggle("dropAfter", index === rows.length && position === rows.length - 1);
    });
  }

  function drop(items) {
    const movedId = draggedId;
    const target = dropIndex;
    // End the drag first, so the list redraws when the move fires a change.
    draggedId = null;
    setDropIndex(null);
    if (movedId === null || target === null) return;
    const from = items.findIndex((item) => item.id === movedId);
    // Taking the row out first shifts everything after it up by one.
    queue.move(movedId, target > from ? target - 1 : target);
  }

  function row(item, index, state) {
    const isCurrent = item.id === state.currentId;
    const classes = ["queuePanel-row", isCurrent && "current", item.dj && "fromDj"].filter(Boolean).join(" ");
    const entry = element("li", { className: classes, draggable: "true" }, [
      element("span", { className: "queuePanel-handle", "aria-hidden": "true", text: "⋮⋮" }),
      element("span", { className: "queuePanel-number", text: String(index + 1) }),
      element("div", { className: "queuePanel-track" }, [
        element("strong", { text: item.title }),
        element("small", { text: isCurrent ? "Now playing" : item.detail }),
      ]),
      element("div", { className: "queuePanel-actions" }, [
        element("button", {
          type: "button",
          title: "Play this song",
          "aria-label": `Play ${item.title}`,
          text: "▶",
          onClick: () => {
            deck.ensureContext();
            queue.play(item.id);
          },
        }),
        element("button", {
          type: "button",
          className: "secondary",
          title: "Remove from the queue",
          "aria-label": `Remove ${item.title}`,
          text: "✕",
          onClick: () => queue.remove(item.id),
        }),
      ]),
    ]);
    entry.addEventListener("dragstart", (event) => {
      draggedId = item.id;
      entry.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(item.id));
    });
    entry.addEventListener("dragover", (event) => {
      event.preventDefault();
      const rect = entry.getBoundingClientRect();
      setDropIndex(event.clientY < rect.top + rect.height / 2 ? index : index + 1);
    });
    entry.addEventListener("drop", (event) => {
      event.preventDefault();
      drop(state.items);
    });
    entry.addEventListener("dragend", () => {
      entry.classList.remove("dragging");
      // Dropped outside the list (or cancelled): redraw anything that changed meanwhile.
      if (draggedId !== null) {
        draggedId = null;
        setDropIndex(null);
        render();
      }
    });
    return entry;
  }

  function render() {
    if (draggedId !== null) return; // don't rebuild rows mid-drag
    const state = queue.getState();
    list.replaceChildren(...state.items.map((item, index) => row(item, index, state)));
    empty.hidden = state.items.length > 0;
    status.hidden = !state.status;
    status.textContent = state.status?.message ?? "";
    status.classList.toggle("error", Boolean(state.status?.isError));

    const { dj } = state;
    djRow.classList.toggle("on", dj.on);
    startButton.textContent = dj.on ? "Change vibe" : "Start";
    djButtons.replaceChildren(...(dj.on ? [startButton, stopButton] : [startButton]));
    const djMessage = dj.talking ? "🎙 The DJ is on the mic…" : dj.status?.message ?? (dj.on ? "DJ on: it moves to the next song when one ends." : "");
    djStatus.hidden = !djMessage;
    djStatus.textContent = djMessage;
    djStatus.classList.toggle("error", Boolean(dj.status?.isError));
  }

  queue.on(render);
  render();
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) controls.close();
  });

  const controls = {
    get isOpen() {
      return !panel.hidden;
    },
    open() {
      panel.hidden = false;
    },
    close() {
      panel.hidden = true;
    },
    toggle() {
      panel.hidden = !panel.hidden;
    },
  };
  return controls;
}
