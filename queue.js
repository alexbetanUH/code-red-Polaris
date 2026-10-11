// Song queue for the Deck in audio.js: add songs from YouTube (a link or a song
// name, downloaded by server.py) or from files, reorder, remove, play one, or
// skip to the next. Plus a floating panel to do all of that.
//
//   const queue = createQueue(deck);
//   const panel = createQueuePanel(queue);
//   queueButton.onclick = () => { deck.ensureContext(); panel.toggle(); };
//
// Call deck.ensureContext() inside clicks before queue actions: browsers only
// allow sound after one. The panel already does this for its own buttons.

export function createQueue(deck, { endpoint = "/api/youtube" } = {}) {
  let items = []; // { id, title, detail, url } for YouTube downloads, { id, title, detail, file } for files
  let currentId = null;
  let status = null; // { message, isError } while adding or loading
  let nextId = 1;
  const listeners = new Set();

  const changed = () => listeners.forEach((listener) => listener());
  function setStatus(message, isError = false) {
    status = message ? { message, isError } : null;
    changed();
  }

  // The first song added plays right away, like loading one did before.
  function add(item) {
    items = [...items, { id: nextId++, ...item }];
    changed();
    if (currentId === null) queue.play(items[items.length - 1].id);
  }

  const queue = {
    getState: () => ({ items, currentId, status }),

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
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: text }),
        });
        if (response.status === 501) throw new Error("start the app with `python server.py` to enable YouTube");
        const body = await response.json();
        if (!response.ok) throw new Error(body.error);
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
    },

    async play(id) {
      const item = items.find((entry) => entry.id === id);
      if (!item) return;
      setStatus(`Loading ${item.title}…`);
      try {
        if (item.url) await deck.loadUrl(item.url);
        else await deck.loadFile(item.file);
        deck.play();
        currentId = id;
        setStatus(null);
      } catch (error) {
        setStatus(`Error: ${error.message}`, true);
      }
    },

    // Plays the song after the current one, wrapping to the top.
    next() {
      if (!items.length) return;
      const position = items.findIndex((entry) => entry.id === currentId);
      queue.play(items[(position + 1) % items.length].id);
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
.queuePanel-add { display: flex; gap: 6px; }
.queuePanel-add input[type="text"] {
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
  const list = element("ol", { className: "queuePanel-list" });
  const empty = element("p", { className: "queuePanel-empty", text: "The queue is empty. Add a YouTube link, song name or file." });

  function addFromInput() {
    deck.ensureContext(); // inside the click, so the browser allows sound
    queue.addYouTube(input.value);
    input.value = "";
  }
  input.addEventListener("keydown", (event) => event.key === "Enter" && addFromInput());
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
        element("p", { text: "Drag to reorder. ▶ plays a song, Next goes down the list." }),
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
    const entry = element("li", { className: `queuePanel-row ${isCurrent ? "current" : ""}`, draggable: "true" }, [
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
