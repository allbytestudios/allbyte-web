/* Instruction Booklet inline editor — injected into the standalone /manual/ page
 * by sync-manual.js. Mirrors the walkthrough edit overlay:
 *  - FOR EVERYONE: fetch the per-section overrides and swap the affected .prose
 *    so an owner's edit shows live (rendered by renderMd, below).
 *  - FOR ADMINS: an "Edit" button per single-file section opens the section's
 *    body markdown; saving overlays it live over Quinn's export and appends the
 *    diff to her feed (server-side). Body-only; the structured frontmatter
 *    (stat cards, icons, callouts) comes from Quinn's source, untouched.
 * Cast/bestiary per-entry editing is a follow-up (they nest sub-entries).
 */
(function () {
  "use strict";
  // Embedded (e.g. the /play left-letterbox iframe): hide the home back-link so
  // it doesn't navigate the panel away.
  if (window.self !== window.top) {
    var _mh = document.querySelector(".manual-home");
    if (_mh) _mh.style.display = "none";
  }
  var MANUAL_API = "%%MANUAL_API%%";
  var AUTH_API = "https://api.allbyte.studio";
  var bodies = {};
  try { bodies = JSON.parse(document.getElementById("manual-bodies").textContent || "{}"); } catch (e) {}
  var overrides = {};
  var token = null;

  // ---- markdown -> HTML (the manual's prose subset, incl. pipe tables) ------
  function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function inline(raw) {
    var t = esc(raw);
    t = t.replace(/`([^`]+)`/g, function (_, c) { return "<code>" + c + "</code>"; });
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, x, u) { return '<a href="' + u + '">' + x + "</a>"; });
    t = t.replace(/\[([^\]]+)\]/g, function (_, x) { return '<span class="item">' + x + "</span>"; }); // [Item] chips
    t = t.replace(/\*\*([^*]+)\*\*/g, function (_, b) { return "<strong>" + b + "</strong>"; });
    t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, function (_, p, i) { return p + "<em>" + i + "</em>"; });
    return t;
  }
  function calloutClass(inner) {
    var lead = (inner.match(/^\s*\*\*([^*]+)\*\*/) || [])[1] || "";
    if (/pro\s*tip/i.test(lead) || /^💡/.test(inner)) return ' class="callout"';
    return ' class="callout"';
  }
  function table(rows) {
    // rows: array of raw "| a | b |" lines; rows[1] is the |---| separator
    var cells = function (r) { return r.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map(function (c) { return c.trim(); }); };
    var head = cells(rows[0]);
    var body = rows.slice(2).map(function (r) { return cells(r); });
    var h = "<thead><tr>" + head.map(function (c) { return "<th>" + inline(c) + "</th>"; }).join("") + "</tr></thead>";
    var b = "<tbody>" + body.map(function (r) { return "<tr>" + r.map(function (c) { return "<td>" + inline(c) + "</td>"; }).join("") + "</tr>"; }).join("") + "</tbody>";
    return '<div class="tbl-wrap"><table>' + h + b + "</table></div>";
  }
  function renderMd(md) {
    var lines = (md || "").replace(/\r\n/g, "\n").split("\n");
    var out = [], i = 0;
    var isTableSep = function (s) { return /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(s) && s.indexOf("-") >= 0; };
    while (i < lines.length) {
      var line = lines[i];
      if (!line.trim()) { i++; continue; }
      if (/^\s*---+\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
      var h = line.match(/^\s*(#{2,6})\s+(.*)$/);
      if (h) { var lv = Math.max(2, h[1].length); out.push("<h" + lv + ">" + inline(h[2]) + "</h" + lv + ">"); i++; continue; }
      if (/^\s*\|.*\|/.test(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        var tr = []; while (i < lines.length && /^\s*\|/.test(lines[i])) { tr.push(lines[i]); i++; }
        out.push(table(tr)); continue;
      }
      if (/^\s*>/.test(line)) {
        var buf = []; while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
        var inner = buf.join("\n");
        var paras = inner.split(/\n{2,}/).map(function (p) { return "<p>" + inline(p.replace(/\n/g, " ")) + "</p>"; }).join("");
        out.push("<blockquote" + calloutClass(inner) + ">" + paras + "</blockquote>"); continue;
      }
      if (/^\s*[-*]\s+/.test(line)) {
        var lb = []; while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { lb.push(lines[i].replace(/^\s*[-*]\s+/, "")); i++; }
        out.push("<ul>" + lb.map(function (li) { return "<li>" + inline(li) + "</li>"; }).join("") + "</ul>"); continue;
      }
      if (/^\s*\d+\.\s+/.test(line)) {
        var ob = []; while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { ob.push(lines[i].replace(/^\s*\d+\.\s+/, "")); i++; }
        out.push("<ol>" + ob.map(function (li) { return "<li>" + inline(li) + "</li>"; }).join("") + "</ol>"); continue;
      }
      var pb = []; while (i < lines.length && lines[i].trim() && !/^\s*(>|#{2,6}\s|[-*]\s|\d+\.\s|\||---+\s*$)/.test(lines[i])) { pb.push(lines[i]); i++; }
      out.push("<p>" + inline(pb.join(" ")) + "</p>");
    }
    return out.join("\n");
  }

  // ---- apply overrides ------------------------------------------------------
  function proseOf(key) {
    var leaf = document.querySelector('.leaf[data-section="' + (window.CSS && CSS.escape ? CSS.escape(key) : key) + '"]');
    return leaf ? leaf.querySelector(".prose") : null;
  }
  function applyOne(key) {
    var el = proseOf(key), ov = overrides[key];
    if (el && ov) {
      var rendered = renderMd(ov.edited_md);
      if (typeof normalizeDashes === "function") rendered = normalizeDashes(rendered); // no em-dashes (AI tell)
      el.innerHTML = rendered;
      el.closest(".leaf").setAttribute("data-overridden", "true");
    }
  }
  function applyAll() { Object.keys(overrides).forEach(applyOne); }

  function loadOverrides() {
    return fetch(MANUAL_API + "/manual-overrides").then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (d) { overrides = (d && d.overrides) || {}; }).catch(function () {});
  }
  function checkAdmin() {
    token = localStorage.getItem("allbyte_token");
    if (!token) return Promise.resolve(false);
    return fetch(AUTH_API + "/auth/me", { headers: { Authorization: "Bearer " + token } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { var t = (d && (d.tier || (d.user && d.user.tier))) || ""; return String(t).toLowerCase() === "admin"; })
      .catch(function () { return false; });
  }

  // ---- admin edit affordance ------------------------------------------------
  // Grouped chapters render several .md files as one leaf (e.g. "Combat" =
  // battle + screen + status_damage). A single-file overlay would clobber the
  // other files' content, so skip them until multi-file editing lands.
  var GROUPED = { battle: 1 };
  function injectButtons() {
    var leaves = document.querySelectorAll(".leaf[data-section]");
    for (var i = 0; i < leaves.length; i++) {
      var leaf = leaves[i], key = leaf.getAttribute("data-section");
      if (!bodies[key] || GROUPED[key]) continue; // single-file, non-grouped sections only
      var head = leaf.querySelector(".leaf-head");
      if (!head || head.querySelector(".manual-edit-btn")) continue;
      var b = document.createElement("button");
      b.className = "manual-edit-btn"; b.type = "button"; b.textContent = "Edit";
      (function (k) { b.addEventListener("click", function () { openEditor(k); }); })(key);
      head.appendChild(b);
    }
  }

  var modal = null;
  function openEditor(key) {
    var base = bodies[key] || "";
    var cur = overrides[key] ? overrides[key].edited_md : base;
    closeModal();
    modal = document.createElement("div"); modal.className = "me-wrap";
    modal.innerHTML =
      '<div class="me-scrim"></div><div class="me-panel" role="dialog" aria-modal="true">' +
      '<div class="me-head"><span>Edit <b>' + esc(key) + '</b></span><button class="me-x" aria-label="Cancel">✕</button></div>' +
      '<p class="me-hint">Section body only. The frontmatter (stat cards, icons, callouts) stays Quinn’s source. Goes live and is sent to Quinn.</p>' +
      '<textarea class="me-md" spellcheck="true"></textarea>' +
      '<label class="me-note-l">Why did you change it? <span class="me-opt">(optional, it’s what Quinn learns from)</span>' +
      '<input class="me-note" placeholder="e.g. wrote the real bio; tightened the phrasing" /></label>' +
      '<div class="me-actions"><button class="me-cancel">Cancel</button><button class="me-save">Save &amp; publish</button></div></div>';
    document.body.appendChild(modal);
    var ta = modal.querySelector(".me-md"); ta.value = cur;
    modal.querySelector(".me-scrim").addEventListener("click", closeModal);
    modal.querySelector(".me-x").addEventListener("click", closeModal);
    modal.querySelector(".me-cancel").addEventListener("click", closeModal);
    modal.querySelector(".me-save").addEventListener("click", function () {
      save(key, ta.value, modal.querySelector(".me-note").value, base, this);
    });
    ta.focus();
  }
  function closeModal() { if (modal) { modal.remove(); modal = null; } }
  function toast(msg, ok) {
    var t = document.createElement("div"); t.className = "me-toast" + (ok ? "" : " err"); t.textContent = msg;
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, 3400);
  }
  function save(key, md, note, base, btn) {
    if (!md.trim()) return;
    btn.disabled = true; btn.textContent = "Saving…";
    fetch(MANUAL_API + "/manual-override", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ key: key, edited_md: md, base_md: base, note: note.trim() || undefined })
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (res.ok && res.d.override) { overrides[key] = res.d.override; applyOne(key); toast("Saved " + key + " · sent to Quinn’s feed", true); closeModal(); }
        else { btn.disabled = false; btn.textContent = "Save & publish"; toast((res.d && res.d.error) || "Save failed", false); }
      }).catch(function (e) { btn.disabled = false; btn.textContent = "Save & publish"; toast("Save failed", false); });
  }
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && modal) closeModal(); });

  // ---- go -------------------------------------------------------------------
  loadOverrides().then(function () { applyAll(); return checkAdmin(); }).then(function (admin) { if (admin) injectButtons(); });
})();
