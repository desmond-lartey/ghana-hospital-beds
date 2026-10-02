/* Map review sessions.
   ---------------------------------------------------------------------------
   Two or more people open the same map from a session code and leave notes
   anchored to specific hospitals: a pin in the wrong place, a number that no
   longer answers, a facility that has moved. Notes persist, so the session
   produces a correction list rather than a conversation that evaporates.

   This is not an emergency channel, and the interface says so rather than
   leaving it to be inferred.

   HOW LIVENESS WORKS

   Every note and reply is written through a security definer function in the
   database, which checks the session code before it does anything. That write
   is the authority: if it fails, nothing happened.

   Supabase Realtime then carries the same change to everyone else in the
   session so their screen updates without a refresh, and carries cursors so you
   can see where the other person is looking. Realtime is a courier, never a
   source of truth - if the socket never connects, a poll every twelve seconds
   keeps the session correct, just less immediate. Losing the socket costs
   latency, not data. */

(function () {
  "use strict";

  /* ------------------------------------------------------------- constants */

  var POLL_MS = 12000;        // fallback refresh when the socket is not carrying
  var CURSOR_MS = 60;         // throttle on outbound cursor movement
  var PRESENCE_TTL = 30000;   // drop a cursor we have not heard from since

  var LS_NAME = "ahb_review_name";
  var LS_CODE = "ahb_review_code";

  // Assigned by hashing the client id, so the same person keeps a colour for
  // the session and two people rarely collide.
  var COLORS = [
    "#1e3a8f", "#e0201b", "#0e7a54", "#a86608",
    "#6d28d9", "#0e7490", "#b91c5c", "#4d7c0f"
  ];

  var KIND_LABEL = {
    location: "Wrong location",
    phone:    "Phone number",
    details:  "Details",
    missing:  "Missing facility",
    other:    "Other"
  };

  /* ----------------------------------------------------------------- state */

  var sb = null;
  var map = null;
  var channel = null;
  var channelReady = false;   // set once the socket is actually carrying
  var pollTimer = null;

  var session = null;   // { code, label, expires } once open
  var notes = [];       // ProjectComment-shaped records from the database
  var filter = "open";
  var placing = false;  // the "add note" tool is armed
  var pending = null;   // { lng, lat, hospitalId, hospitalName } awaiting a body
  var selectedId = null;

  var hospitals = [];   // published hospitals, for anchoring and context
  var noteMarkers = [];
  var peers = {};       // clientId -> { name, color, lng, lat, at, marker }

  var me = {
    clientId: Math.random().toString(36).slice(2, 10),
    name: "",
    color: COLORS[0]
  };

  /* ------------------------------------------------------------- utilities */

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function colorFor(id) {
    var h = 0;
    for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return COLORS[h % COLORS.length];
  }

  function store(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (e) { /* private browsing; the session still works in memory */ }
  }

  function read(key) {
    try { return localStorage.getItem(key) || ""; } catch (e) { return ""; }
  }

  function timeAgo(iso) {
    var secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (secs < 60) return "just now";
    if (secs < 3600) return Math.floor(secs / 60) + "m ago";
    if (secs < 86400) return Math.floor(secs / 3600) + "h ago";
    return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }

  function initials(name) {
    var parts = String(name || "?").trim().split(/\s+/);
    return ((parts[0] || "?")[0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
  }

  // Straight-line metres. Only ever used to decide which hospital a dropped pin
  // is nearest to, so the small-angle approximation is more than good enough.
  function metresBetween(aLng, aLat, bLng, bLat) {
    var dx = (bLng - aLng) * 111320 * Math.cos(aLat * Math.PI / 180);
    var dy = (bLat - aLat) * 110540;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function supabaseReady() {
    if (sb) return sb;
    if (!window.SUPABASE_URL || window.SUPABASE_URL.indexOf("YOUR-PROJECT-REF") !== -1) return null;
    if (!window.supabase) return null;
    sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
    return sb;
  }

  function say(message, kind) {
    var box = $("session-msg");
    if (!box) return;
    if (!message) { box.hidden = true; return; }
    box.textContent = message;
    box.className = "session-msg " + (kind || "info");
    box.hidden = false;
  }

  /* ------------------------------------------------------------------- map */

  function initMap() {
    try {
      map = new maplibregl.Map({
        container: "review-map",
        style: "https://tiles.openfreemap.org/styles/liberty",
        center: [-0.196, 5.578],
        zoom: 11,
        attributionControl: true
      });
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
      map.on("load", function () {
        drawHospitals();
        drawNotes();
      });
      map.on("click", onMapClick);
      map.on("mousemove", onMapMove);
      map.on("error", function () { /* tile hiccups are not worth a dialog */ });
    } catch (err) {
      $("review-map").innerHTML =
        '<p class="map-fallback">The map could not load. Notes can still be read in the panel.</p>';
    }
  }

  // Published hospitals as small reference dots. They are context, not the
  // subject, so they stay quiet next to the note pins.
  function drawHospitals() {
    hospitals.forEach(function (h) {
      var el = document.createElement("div");
      el.className = "hosp-dot";
      el.title = h.name;
      new maplibregl.Marker({ element: el })
        .setLngLat([h.longitude, h.latitude])
        .setPopup(new maplibregl.Popup({ offset: 12 }).setHTML(
          "<strong>" + esc(h.name) + "</strong><br>" +
          esc(h.region_area || "") +
          (h.location_confidence === "verified"
            ? '<br><span style="color:#0e7a54">Position verified</span>'
            : '<br><span style="color:#a86608">Position not verified</span>')
        ))
        .addTo(map);
    });
  }

  function drawNotes() {
    noteMarkers.forEach(function (m) { m.remove(); });
    noteMarkers = [];
    if (!map) return;

    visibleNotes().forEach(function (note, index) {
      var el = document.createElement("div");
      el.className = "note-pin" + (note.resolved ? " resolved" : "") +
                     (note.id === selectedId ? " selected" : "");
      el.style.setProperty("--pin", note.author_color || "#1e3a8f");
      el.innerHTML = "<span>" + (index + 1) + "</span>";
      el.setAttribute("role", "button");
      el.setAttribute("tabindex", "0");
      el.setAttribute("aria-label", "Note " + (index + 1) + " by " + note.author_name);
      el.addEventListener("click", function (ev) {
        ev.stopPropagation();
        selectNote(note.id);
      });

      noteMarkers.push(
        new maplibregl.Marker({ element: el, anchor: "bottom" })
          .setLngLat([note.longitude, note.latitude])
          .addTo(map)
      );
    });
  }

  function onMapClick(ev) {
    if (!placing) return;
    var lng = ev.lngLat.lng, lat = ev.lngLat.lat;

    // Anchor to a hospital when the click lands near one. 400m is wide enough
    // to catch a deliberate tap on a dot and narrow enough that a note about
    // open ground does not get attributed to a hospital down the road.
    var nearest = null, best = Infinity;
    hospitals.forEach(function (h) {
      var d = metresBetween(lng, lat, h.longitude, h.latitude);
      if (d < best) { best = d; nearest = h; }
    });

    pending = {
      lng: lng,
      lat: lat,
      hospitalId: best <= 400 && nearest ? nearest.id : null,
      hospitalName: best <= 400 && nearest ? nearest.name : null
    };

    setPlacing(false);
    openComposer();
  }

  function onMapMove(ev) {
    if (!channel || !channelReady || !session) return;
    var now = Date.now();
    if (onMapMove.last && now - onMapMove.last < CURSOR_MS) return;
    onMapMove.last = now;
    channel.send({
      type: "broadcast",
      event: "cursor",
      payload: {
        id: me.clientId, name: me.name || "Guest", color: me.color,
        lng: ev.lngLat.lng, lat: ev.lngLat.lat
      }
    });
  }

  function setPlacing(on) {
    placing = on;
    var btn = $("btn-add-note");
    if (btn) {
      btn.setAttribute("aria-pressed", String(on));
      btn.textContent = on ? "Click the map…" : "Add note";
    }
    var canvas = $("review-map");
    if (canvas) canvas.classList.toggle("placing", on);
    var hint = $("placing-hint");
    if (hint) hint.hidden = !on;
  }

  /* --------------------------------------------------------------- presence */

  function paintPeer(payload) {
    if (!payload || payload.id === me.clientId || !map) return;

    var peer = peers[payload.id];
    if (!peer) {
      var el = document.createElement("div");
      el.className = "peer-cursor";
      el.style.setProperty("--peer", payload.color || "#1e3a8f");
      el.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' +
        '<path d="M5 3l14 8-6 1.5L10 19z"/></svg><span></span>';
      peer = peers[payload.id] = {
        marker: new maplibregl.Marker({ element: el, anchor: "top-left" })
          .setLngLat([payload.lng, payload.lat]).addTo(map),
        el: el
      };
    }
    peer.name = payload.name;
    peer.color = payload.color;
    peer.at = Date.now();
    peer.el.querySelector("span").textContent = payload.name || "Guest";
    peer.el.style.setProperty("--peer", payload.color || "#1e3a8f");
    peer.marker.setLngLat([payload.lng, payload.lat]);
    renderPresence();
  }

  // A cursor that stops moving is a tab someone left open, not a person. They
  // are swept rather than left hovering over the map indefinitely.
  function sweepPeers() {
    var now = Date.now(), changed = false;
    Object.keys(peers).forEach(function (id) {
      if (now - peers[id].at > PRESENCE_TTL) {
        peers[id].marker.remove();
        delete peers[id];
        changed = true;
      }
    });
    if (changed) renderPresence();
  }

  function renderPresence() {
    var box = $("presence-list");
    if (!box) return;
    var ids = Object.keys(peers);
    var count = ids.length + 1;

    $("session-state").textContent = session
      ? "Live · " + count + (count === 1 ? " person" : " people")
      : "Offline · private workspace";

    box.innerHTML = [{ name: me.name || "You", color: me.color }]
      .concat(ids.map(function (id) { return peers[id]; }))
      .map(function (p) {
        return '<span class="avatar" style="background:' + esc(p.color) + '" title="' +
               esc(p.name || "Guest") + '">' + esc(initials(p.name || "Guest")) + "</span>";
      }).join("");
  }

  /* ---------------------------------------------------------------- realtime */

  function openChannel(code) {
    if (!sb) return;
    closeChannel();
    channelReady = false;

    channel = sb.channel("review:" + code, {
      config: { broadcast: { self: false } }
    });

    channel
      .on("broadcast", { event: "cursor" }, function (m) { paintPeer(m.payload); })
      .on("broadcast", { event: "note-added" }, function (m) {
        if (!m.payload || findNote(m.payload.id)) return;
        notes.push(m.payload);
        render();
      })
      .on("broadcast", { event: "reply-added" }, function (m) {
        var note = findNote(m.payload && m.payload.note_id);
        if (!note) return;
        if ((note.replies || []).some(function (r) { return r.id === m.payload.id; })) return;
        note.replies = (note.replies || []).concat([m.payload]);
        render();
      })
      .on("broadcast", { event: "note-resolved" }, function (m) {
        var note = findNote(m.payload && m.payload.id);
        if (!note) return;
        note.resolved = !!m.payload.resolved;
        render();
      })
      .on("broadcast", { event: "note-deleted" }, function (m) {
        notes = notes.filter(function (n) { return n.id !== (m.payload && m.payload.id); });
        render();
      })
      .subscribe(function (status) {
        var dot = $("session-dot");
        if (!dot) return;
        // A failed socket is not a failed session: the poll below keeps notes
        // current either way, so this reports reduced liveness, not an outage.
        channelReady = status === "SUBSCRIBED";
        if (status === "SUBSCRIBED") {
          dot.className = "dot live";
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          dot.className = "dot degraded";
          $("session-state").textContent = "Live · refreshing every few seconds";
        }
      });
  }

  function closeChannel() {
    if (channel && sb) { sb.removeChannel(channel); }
    channel = null;
    channelReady = false;
    Object.keys(peers).forEach(function (id) { peers[id].marker.remove(); });
    peers = {};
  }

  function broadcast(event, payload) {
    // Not an error when the socket is not up: the note is already written, and
    // the other side's poll will collect it.
    if (!channel || !channelReady) return;
    channel.send({ type: "broadcast", event: event, payload: payload });
  }

  /* ------------------------------------------------------------------ data */

  function findNote(id) {
    for (var i = 0; i < notes.length; i++) if (notes[i].id === id) return notes[i];
    return null;
  }

  function visibleNotes() {
    return notes.filter(function (n) {
      if (filter === "open") return !n.resolved;
      if (filter === "resolved") return n.resolved;
      return true;
    });
  }

  function loadHospitals() {
    if (!sb) return Promise.resolve();
    return sb.from("public_hospitals").select("*").then(function (res) {
      if (res.error || !res.data) return;
      hospitals = res.data.filter(function (h) {
        return h.latitude != null && h.longitude != null;
      });
      fillHospitalDatalist();
    }).catch(function () { /* the map still works without the dots */ });
  }

  function fillHospitalDatalist() {
    var list = $("hospital-options");
    if (!list) return;
    list.innerHTML = hospitals.map(function (h) {
      return '<option value="' + esc(h.name) + '">';
    }).join("");
  }

  function refresh() {
    if (!sb || !session) return Promise.resolve();
    return sb.rpc("open_review_session", { p_code: session.code }).then(function (res) {
      if (res.error) {
        // The session ended underneath us - expired, or closed by an
        // administrator. Say so instead of polling a dead code forever.
        stopPolling();
        say("This session has ended. The notes are kept, but the code no longer opens.", "warn");
        return;
      }
      notes = (res.data && res.data.notes) || [];
      render();
    });
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(refresh, POLL_MS);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  /* ------------------------------------------------------------- rendering */

  function render() {
    renderList();
    renderCounts();
    drawNotes();
  }

  function renderCounts() {
    var open = notes.filter(function (n) { return !n.resolved; }).length;
    var done = notes.length - open;
    $("count-badge").textContent = String(open);
    $("tab-open").textContent = "Open (" + open + ")";
    $("tab-resolved").textContent = "Resolved (" + done + ")";
    $("tab-all").textContent = "All (" + notes.length + ")";
  }

  function hospitalName(id) {
    for (var i = 0; i < hospitals.length; i++) {
      if (hospitals[i].id === id) return hospitals[i].name;
    }
    return null;
  }

  function renderList() {
    var list = $("note-list");
    var rows = visibleNotes();

    if (!session) {
      list.innerHTML =
        '<div class="empty">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">' +
        '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' +
        "<p><b>No session open</b></p>" +
        "<p>Start a session to begin a review, or enter a code you were given.</p>" +
        "</div>";
      return;
    }

    if (!rows.length) {
      list.innerHTML =
        '<div class="empty">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">' +
        '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' +
        "<p><b>" + (filter === "resolved" ? "Nothing resolved yet" : "No open notes") + "</b></p>" +
        '<p>Choose <b>Add note</b>, then click the hospital or place on the map you want to raise.</p>' +
        "</div>";
      return;
    }

    list.innerHTML = rows.map(function (note, index) {
      var place = note.hospital_id ? hospitalName(note.hospital_id) : null;
      var replies = note.replies || [];

      return '<article class="note' + (note.resolved ? " is-resolved" : "") +
             (note.id === selectedId ? " is-selected" : "") +
             '" data-id="' + esc(note.id) + '">' +
          '<header>' +
            '<span class="pin-no" style="background:' + esc(note.author_color) + '">' + (index + 1) + "</span>" +
            '<div class="who">' +
              "<b>" + esc(note.author_name) + "</b>" +
              "<time>" + esc(timeAgo(note.created_at)) + "</time>" +
            "</div>" +
            '<span class="kind k-' + esc(note.kind) + '">' + esc(KIND_LABEL[note.kind] || "Other") + "</span>" +
          "</header>" +

          (place ? '<p class="anchor">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true">' +
            '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>' +
            esc(place) + "</p>" : "") +

          '<p class="body">' + esc(note.body) + "</p>" +

          (replies.length ? '<div class="replies">' + replies.map(function (r) {
            return '<div class="reply">' +
              '<span class="avatar sm" style="background:' + esc(r.author_color) + '">' +
                esc(initials(r.author_name)) + "</span>" +
              "<div><b>" + esc(r.author_name) + "</b> " +
              "<time>" + esc(timeAgo(r.created_at)) + "</time>" +
              "<p>" + esc(r.body) + "</p></div></div>";
          }).join("") + "</div>" : "") +

          '<div class="note-actions">' +
            '<button type="button" data-act="locate">Show on map</button>' +
            '<button type="button" data-act="reply">Reply</button>' +
            '<button type="button" data-act="resolve">' +
              (note.resolved ? "Reopen" : "Mark resolved") + "</button>" +
            '<button type="button" data-act="delete" class="danger">Delete</button>' +
          "</div>" +

          '<form class="reply-form" hidden>' +
            '<input type="text" placeholder="Add a reply" aria-label="Reply to this note" maxlength="2000">' +
            '<button type="submit" class="btn btn-navy btn-sm">Send</button>' +
          "</form>" +
        "</article>";
    }).join("");
  }

  function selectNote(id) {
    selectedId = id;
    var note = findNote(id);
    if (note && map) {
      map.flyTo({ center: [note.longitude, note.latitude], zoom: Math.max(map.getZoom(), 14), duration: 700 });
    }
    // Reveal whichever filter holds it, so clicking a resolved pin does not
    // scroll to a card the Open tab is hiding.
    if (note && note.resolved && filter === "open") setFilter("resolved");
    else render();

    var card = document.querySelector('.note[data-id="' + id + '"]');
    if (card) card.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function setFilter(next) {
    filter = next;
    ["open", "resolved", "all"].forEach(function (f) {
      $("tab-" + f).setAttribute("aria-pressed", String(f === next));
    });
    render();
  }

  /* -------------------------------------------------------------- composer */

  function openComposer() {
    var dialog = $("composer");
    $("composer-where").textContent = pending.hospitalName
      ? pending.hospitalName
      : "Dropped pin · " + pending.lat.toFixed(5) + ", " + pending.lng.toFixed(5);
    $("composer-body").value = "";
    $("composer-kind").value = pending.hospitalName ? "location" : "missing";
    dialog.hidden = false;
    $("composer-body").focus();
  }

  function closeComposer() {
    $("composer").hidden = true;
    pending = null;
  }

  function submitComposer(ev) {
    ev.preventDefault();
    if (!pending || !session || !sb) return;

    var body = $("composer-body").value.trim();
    if (!body) return;

    var btn = $("composer-save");
    btn.disabled = true;
    btn.textContent = "Saving…";

    sb.rpc("add_review_note", {
      p_code: session.code,
      p_body: body,
      p_latitude: pending.lat,
      p_longitude: pending.lng,
      p_author_name: me.name || "Author",
      p_author_color: me.color,
      p_kind: $("composer-kind").value,
      p_hospital_id: pending.hospitalId
    }).then(function (res) {
      btn.disabled = false;
      btn.textContent = "Save note";
      if (res.error) { say(res.error.message, "bad"); return; }
      notes.push(res.data);
      broadcast("note-added", res.data);
      closeComposer();
      selectedId = res.data.id;
      if (filter === "resolved") setFilter("open"); else render();
    });
  }

  /* ---------------------------------------------------------- note actions */

  function onListClick(ev) {
    var button = ev.target.closest("button[data-act]");
    if (!button) return;
    var card = button.closest(".note");
    var id = card && card.getAttribute("data-id");
    var note = findNote(id);
    if (!note) return;

    var act = button.getAttribute("data-act");

    if (act === "locate") { selectNote(id); return; }

    if (act === "reply") {
      var form = card.querySelector(".reply-form");
      form.hidden = !form.hidden;
      if (!form.hidden) form.querySelector("input").focus();
      return;
    }

    if (act === "resolve") {
      var next = !note.resolved;
      sb.rpc("set_review_note_resolved", {
        p_code: session.code, p_note_id: id, p_resolved: next
      }).then(function (res) {
        if (res.error) { say(res.error.message, "bad"); return; }
        note.resolved = next;
        broadcast("note-resolved", { id: id, resolved: next });
        render();
      });
      return;
    }

    if (act === "delete") {
      if (!window.confirm("Delete this note? This cannot be undone.")) return;
      sb.rpc("delete_review_note", { p_code: session.code, p_note_id: id })
        .then(function (res) {
          if (res.error) { say(res.error.message, "bad"); return; }
          notes = notes.filter(function (n) { return n.id !== id; });
          broadcast("note-deleted", { id: id });
          render();
        });
    }
  }

  function onListSubmit(ev) {
    var form = ev.target.closest(".reply-form");
    if (!form) return;
    ev.preventDefault();

    var card = form.closest(".note");
    var id = card.getAttribute("data-id");
    var input = form.querySelector("input");
    var body = input.value.trim();
    if (!body || !session) return;

    input.disabled = true;
    sb.rpc("add_review_reply", {
      p_code: session.code,
      p_note_id: id,
      p_body: body,
      p_author_name: me.name || "Author",
      p_author_color: me.color
    }).then(function (res) {
      input.disabled = false;
      if (res.error) { say(res.error.message, "bad"); return; }
      var note = findNote(id);
      if (note) note.replies = (note.replies || []).concat([res.data]);
      broadcast("reply-added", res.data);
      input.value = "";
      render();
    });
  }

  /* ------------------------------------------------------------- session UI */

  function enterSession(data) {
    session = { code: data.code, label: data.label, expires: data.expires };
    notes = data.notes || [];
    store(LS_CODE, session.code);

    $("session-idle").hidden = true;
    $("session-live").hidden = false;
    $("code-display").textContent = session.code;
    $("session-label").textContent = session.label || "Untitled review";
    $("btn-add-note").disabled = false;
    $("btn-leave").hidden = false;
    $("session-dot").className = "dot live";

    // Put the code in the address bar so a reload rejoins and the link is the
    // invitation. Nothing secret lives here that the holder of the code does
    // not already have.
    try {
      var url = new URL(window.location.href);
      url.searchParams.set("session", session.code);
      window.history.replaceState({}, "", url);
    } catch (e) { /* ignore */ }

    openChannel(session.code);
    startPolling();
    say("");
    setFilter("open");
    renderPresence();
  }

  function leaveSession() {
    closeChannel();
    stopPolling();
    session = null;
    notes = [];
    selectedId = null;
    store(LS_CODE, null);
    $("session-idle").hidden = false;
    $("session-live").hidden = true;
    $("btn-add-note").disabled = true;
    $("btn-leave").hidden = true;
    setPlacing(false);
    $("session-dot").className = "dot";
    try {
      var url = new URL(window.location.href);
      url.searchParams.delete("session");
      window.history.replaceState({}, "", url);
    } catch (e) { /* ignore */ }
    render();
    renderPresence();
  }

  function startSession() {
    if (!sb) { say("This site is not connected to a database yet.", "bad"); return; }
    var btn = $("btn-start");
    btn.disabled = true;
    btn.textContent = "Starting…";
    say("");

    sb.rpc("create_review_session", {
      p_label: $("new-label").value.trim() || null,
      p_host_name: me.name || null
    }).then(function (res) {
      btn.disabled = false;
      btn.innerHTML = '<span class="live-dot" aria-hidden="true"></span>Start live session';
      if (res.error) { say(res.error.message, "bad"); return; }
      var row = Array.isArray(res.data) ? res.data[0] : res.data;
      enterSession({ code: row.code, label: $("new-label").value.trim(), notes: [] });
    });
  }

  function joinSession(codeFromUrl) {
    if (!sb) { say("This site is not connected to a database yet.", "bad"); return; }
    var code = (codeFromUrl || $("join-code").value || "").trim().toUpperCase();
    if (!code) { say("Enter the session code you were given.", "bad"); return; }

    var btn = $("btn-join");
    btn.disabled = true;
    btn.textContent = "Connecting…";
    say("");

    sb.rpc("open_review_session", { p_code: code }).then(function (res) {
      btn.disabled = false;
      btn.textContent = "Connect";
      if (res.error) {
        say("No open session with that code. Check it and try again.", "bad");
        store(LS_CODE, null);
        return;
      }
      enterSession(res.data);
    });
  }

  function copyInvite() {
    if (!session) return;
    var url = new URL(window.location.href);
    url.searchParams.set("session", session.code);
    var done = function () {
      var btn = $("btn-copy");
      btn.textContent = "Copied";
      setTimeout(function () { btn.textContent = "Copy link"; }, 2000);
    };
    if (navigator.clipboard) navigator.clipboard.writeText(url.toString()).then(done, function () {});
    else done();
  }

  /* ------------------------------------------------------------------ name */

  function renderName() {
    var label = $("name-display");
    if (me.name) {
      label.textContent = me.name;
      label.classList.remove("unset");
    } else {
      label.textContent = 'No name set - notes will show as "Author"';
      label.classList.add("unset");
    }
    renderPresence();
  }

  function saveName() {
    me.name = $("name-input").value.trim().slice(0, 80);
    store(LS_NAME, me.name);
    $("name-edit").hidden = true;
    $("name-row").hidden = false;
    renderName();
  }

  /* ------------------------------------------------------------------ boot */

  function wire() {
    $("btn-start").addEventListener("click", startSession);
    $("btn-join").addEventListener("click", function () { joinSession(); });
    $("join-code").addEventListener("keydown", function (e) {
      if (e.key === "Enter") joinSession();
    });
    $("join-code").addEventListener("input", function (e) {
      e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    });
    $("btn-copy").addEventListener("click", copyInvite);
    $("btn-leave").addEventListener("click", leaveSession);

    $("btn-add-note").addEventListener("click", function () { setPlacing(!placing); });
    $("composer-form").addEventListener("submit", submitComposer);
    $("composer-cancel").addEventListener("click", closeComposer);

    $("note-list").addEventListener("click", onListClick);
    $("note-list").addEventListener("submit", onListSubmit);

    ["open", "resolved", "all"].forEach(function (f) {
      $("tab-" + f).addEventListener("click", function () { setFilter(f); });
    });

    $("name-pencil").addEventListener("click", function () {
      $("name-input").value = me.name;
      $("name-row").hidden = true;
      $("name-edit").hidden = false;
      $("name-input").focus();
    });
    $("name-save").addEventListener("click", saveName);
    $("name-input").addEventListener("keydown", function (e) {
      if (e.key === "Enter") saveName();
      if (e.key === "Escape") { $("name-edit").hidden = true; $("name-row").hidden = false; }
    });

    // C arms the note tool, Escape disarms it or closes the composer. Both are
    // the shortcuts GeoLibre uses, so the habit transfers.
    document.addEventListener("keydown", function (e) {
      var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (e.key === "Escape") {
        if (!$("composer").hidden) closeComposer();
        else if (placing) setPlacing(false);
        return;
      }
      if (typing) return;
      if ((e.key === "c" || e.key === "C") && session) setPlacing(!placing);
    });

    setInterval(sweepPeers, 5000);
  }

  function boot() {
    me.name = read(LS_NAME);
    me.color = colorFor(me.clientId);
    renderName();

    if (!supabaseReady()) {
      say("This site is not connected to a database yet, so sessions cannot be opened.", "bad");
      $("btn-start").disabled = true;
      $("btn-join").disabled = true;
    }

    wire();
    initMap();
    render();
    renderPresence();

    loadHospitals().then(function () {
      if (map && map.loaded()) drawHospitals();

      var fromUrl = new URLSearchParams(window.location.search).get("session");
      var remembered = read(LS_CODE);
      if (fromUrl) joinSession(fromUrl);
      else if (remembered) joinSession(remembered);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
