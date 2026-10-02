/* Site-wide feedback.
   ---------------------------------------------------------------------------
   One button on every page, and a short form behind it. Anyone can report a
   wrong phone number, a hospital that has moved, or a page that will not load,
   without an account and without waiting for anybody to be available.

   This is deliberately NOT the live review session. A review session is
   synchronous and arranged: two people agree to be on the map at the same time.
   Feedback is the opposite — it is for the person who notices something at
   eleven at night and would otherwise have nowhere to put it. So it promises
   nothing about when it will be read, and it says so on the form rather than
   implying a staffed desk.

   The widget builds its own markup, so a page opts in with one script tag and
   nothing else. If this file fails to load, every page is exactly as it was. */

(function () {
  "use strict";

  var SENT_KEY = "ahb_feedback_sent";
  var client = null;
  var built = false;

  function supa() {
    if (client) return client;
    if (!window.SUPABASE_URL || window.SUPABASE_URL.indexOf("YOUR-PROJECT-REF") !== -1) return null;
    if (!window.supabase) return null;
    client = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
    return client;
  }

  function el(id) { return document.getElementById(id); }

  /* ----------------------------------------------------------------- markup */

  function build() {
    if (built) return;
    built = true;

    var host = document.createElement("div");
    host.className = "fb-host";
    host.innerHTML =
      '<button type="button" class="fb-button" id="fb-open" aria-haspopup="dialog">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
             'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>' +
        "</svg>" +
        "<span>Feedback</span>" +
      "</button>" +

      '<div class="fb-wrap" id="fb-wrap" hidden>' +
        '<div class="fb-panel" role="dialog" aria-modal="true" aria-labelledby="fb-title">' +
          '<div class="fb-head">' +
            '<h2 id="fb-title">Tell us what is wrong</h2>' +
            '<button type="button" class="fb-close" id="fb-close" aria-label="Close">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" ' +
                   'stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>' +
            "</button>" +
          "</div>" +

          '<form id="fb-form" class="fb-body">' +
            '<p class="fb-lede">' +
              "Wrong number, a hospital that has moved, a page that will not load — " +
              "anything you noticed. It goes to the people who maintain the map." +
            "</p>" +

            '<label for="fb-kind">What is it about?</label>' +
            '<select id="fb-kind">' +
              '<option value="data">Wrong information about a hospital</option>' +
              '<option value="hospital">A hospital is missing</option>' +
              '<option value="bug">Something on the site is broken</option>' +
              '<option value="idea">A suggestion</option>' +
              '<option value="other">Something else</option>' +
            "</select>" +

            '<label for="fb-message">Your message</label>' +
            '<textarea id="fb-message" required minlength="5" maxlength="4000" ' +
              'placeholder="Tell us what you saw, and what it should say instead."></textarea>' +

            '<label for="fb-contact">Email or phone <span class="fb-opt">optional</span></label>' +
            '<input type="text" id="fb-contact" maxlength="200" autocomplete="email" ' +
              'placeholder="Only if you want a reply">' +
            '<p class="fb-hint">' +
              "Leave it blank and the report is anonymous. We read everything, but " +
              "this is a small team and we cannot promise a reply." +
            "</p>" +

            '<p class="fb-emergency">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
                   'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                '<path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>' +
              "<span>Nobody is on call here. If someone needs help now, " +
              '<a href="tel:112">call 112</a>.</span>' +
            "</p>" +

            '<p class="fb-msg" id="fb-msg" hidden></p>' +

            '<div class="fb-actions">' +
              '<button type="button" class="btn btn-outline-navy" id="fb-cancel">Cancel</button>' +
              '<button type="submit" class="btn btn-red" id="fb-send">Send</button>' +
            "</div>" +
          "</form>" +

          '<div class="fb-done" id="fb-done" hidden>' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" ' +
                 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
              '<path d="M20 6 9 17l-5-5"/></svg>' +
            "<h3>Thank you</h3>" +
            "<p>Your report has been recorded. If it is about a specific hospital, " +
            "it will be checked before anything on the map changes.</p>" +
            '<button type="button" class="btn btn-navy" id="fb-done-close">Close</button>' +
          "</div>" +
        "</div>" +
      "</div>";

    document.body.appendChild(host);
    wire();
  }

  /* ---------------------------------------------------------------- opening */

  var lastFocus = null;

  function open() {
    lastFocus = document.activeElement;
    el("fb-wrap").hidden = false;
    el("fb-form").hidden = false;
    el("fb-done").hidden = true;
    document.body.classList.add("fb-locked");
    setTimeout(function () { el("fb-message").focus(); }, 0);
  }

  function close() {
    el("fb-wrap").hidden = true;
    document.body.classList.remove("fb-locked");
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function say(text, kind) {
    var box = el("fb-msg");
    if (!text) { box.hidden = true; return; }
    box.textContent = text;
    box.className = "fb-msg " + (kind || "bad");
    box.hidden = false;
  }

  /* -------------------------------------------------------------- sending */

  function send(ev) {
    ev.preventDefault();

    var message = el("fb-message").value.trim();
    if (message.length < 5) {
      say("Add a little more detail so the report can be acted on.", "bad");
      el("fb-message").focus();
      return;
    }

    var sb = supa();
    if (!sb) {
      say("This site is not connected to a database yet, so the form cannot send.", "bad");
      return;
    }

    // A crude but effective brake on a stuck finger. It is per-browser and
    // trivially cleared, which is the right weight for a form whose worst case
    // is a duplicate row, not a security problem.
    var lastSent = 0;
    try { lastSent = parseInt(localStorage.getItem(SENT_KEY) || "0", 10); } catch (e) {}
    if (Date.now() - lastSent < 20000) {
      say("That was just sent. Give it a moment before sending another.", "bad");
      return;
    }

    var button = el("fb-send");
    button.disabled = true;
    button.textContent = "Sending…";
    say("");

    sb.from("feedback").insert({
      kind: el("fb-kind").value,
      message: message,
      contact: el("fb-contact").value.trim() || null,
      page: location.pathname + location.search,
      // Truncated to the column's ceiling; a long UA string is not worth a
      // failed insert on a form someone is trying to send in good faith.
      user_agent: (navigator.userAgent || "").slice(0, 500)
    }).then(function (res) {
      button.disabled = false;
      button.textContent = "Send";

      if (res.error) {
        say("That could not be sent just now. Please try again in a moment.", "bad");
        return;
      }

      try { localStorage.setItem(SENT_KEY, String(Date.now())); } catch (e) {}
      el("fb-form").hidden = true;
      el("fb-done").hidden = false;
      el("fb-message").value = "";
      el("fb-contact").value = "";
      el("fb-done-close").focus();
    });
  }

  /* ----------------------------------------------------------------- wiring */

  function wire() {
    el("fb-open").addEventListener("click", open);
    el("fb-close").addEventListener("click", close);
    el("fb-cancel").addEventListener("click", close);
    el("fb-done-close").addEventListener("click", close);
    el("fb-form").addEventListener("submit", send);

    el("fb-wrap").addEventListener("click", function (ev) {
      if (ev.target === el("fb-wrap")) close();
    });

    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && !el("fb-wrap").hidden) close();
    });

    // Any link or button marked data-feedback opens the same form, so the
    // footer entry and the floating button are one thing with two doors.
    document.addEventListener("click", function (ev) {
      var trigger = ev.target.closest("[data-feedback]");
      if (!trigger) return;
      ev.preventDefault();
      open();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", build);
  } else {
    build();
  }
})();
