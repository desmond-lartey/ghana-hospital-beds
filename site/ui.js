/* Header behaviour shared by every page: the mobile menu and the nav dropdowns.
   Kept deliberately small. Nothing here is required for the map, the hospital
   list or any form to work — if this file fails to load, every link in the
   header is still a plain link that goes where it says it goes. */

(function () {
  "use strict";

  /* ------------------------------------------------------------- mobile nav */

  var burger = document.getElementById("burger");
  var nav = document.getElementById("nav");

  if (burger && nav) {
    burger.addEventListener("click", function () {
      var opening = nav.getAttribute("data-open") !== "true";
      nav.setAttribute("data-open", String(opening));
      burger.setAttribute("aria-expanded", String(opening));
    });
  }

  /* --------------------------------------------------------------- dropdown */

  var drops = Array.prototype.slice.call(document.querySelectorAll(".drop"));

  function closeAll(except) {
    drops.forEach(function (drop) {
      if (drop === except) return;
      drop.setAttribute("data-open", "false");
      var menu = drop.querySelector(".drop-menu");
      var btn = drop.querySelector(".nav-top");
      if (menu) menu.hidden = true;
      if (btn) btn.setAttribute("aria-expanded", "false");
    });
  }

  drops.forEach(function (drop) {
    var btn = drop.querySelector(".nav-top");
    var menu = drop.querySelector(".drop-menu");
    if (!btn || !menu) return;

    btn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      var opening = menu.hidden;
      closeAll(drop);
      menu.hidden = !opening;
      drop.setAttribute("data-open", String(opening));
      btn.setAttribute("aria-expanded", String(opening));
    });
  });

  // Clicking elsewhere or pressing Escape closes an open menu, which is what a
  // menu is expected to do.
  document.addEventListener("click", function () { closeAll(null); });
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape") closeAll(null);
  });

  /* ------------------------------------------------------------------- year */

  var year = document.getElementById("year");
  if (year) year.textContent = new Date().getFullYear();
})();
