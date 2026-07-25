/**
 * dash-normalize.js - strip em/en dashes from rendered manual/walkthrough HTML.
 *
 * The owner's house rule (owned by Arc for dialogue; ChroniclesOfNesis/authoring/
 * dispatch_dialogue_regen.md): an em-dash reads as an AI tell - remove every
 * em-dash and the "--" digraph. The replacement is CONTEXT-DEPENDENT:
 *   - Label - value (list-item / table-cell / heading / caption)  -> "Label: value"
 *   - default aside / appositive / mid-sentence break             -> ", "
 *   - trailing hesitation (dash then end-of-block)                -> ".."
 *   - lone placeholder cell (empty <dd> holding just a dash)      -> "-"
 *   - en-dash numeric range (3-5)                                 -> "3-5"  (owner call)
 * Sentence-join -> period+capitalize is intentionally NOT auto-detected (risky
 * auto-capitalization); those fall to comma and can be hand-polished.
 *
 * Shared by scripts/sync-manual.js (Node, on the built HTML) and injected into
 * the client manual editor so overlay edits render dash-free too. Operates on
 * HTML: <script>, <style>, and comments are masked so code/comment delimiters
 * (incl. the banned "--") are never touched. The mask sentinel is a private-use
 * codepoint so it can never collide with real digits in content.
 */
export function normalizeDashes(html) {
  if (!html) return html;
  var S = String.fromCharCode(0xE000);
  var masks = [];
  function M(m) { masks.push(m); return S + (masks.length - 1) + S; }
  var w = html
    .replace(/<script[\s\S]*?<\/script>/gi, M)
    .replace(/<style[\s\S]*?<\/style>/gi, M)
    .replace(/<!--[\s\S]*?-->/g, M);

  var EM = "—";       // em-dash
  var EN = "–";       // en-dash
  var reEnRange = new RegExp("(\\d)\\s*(?:&#8211;|&ndash;|" + EN + ")\\s*(\\d)", "g");
  var reEnAny = new RegExp("&#8211;|&ndash;|" + EN, "g");
  var emAlt = "&#8212;|&mdash;|" + EM + "|--";

  // en-dash numeric range -> hyphen; leftover en-dash unifies to em handling
  w = w.replace(reEnRange, "$1-$2");
  w = w.replace(reEnAny, EM);

  // TRUE lone placeholder: <tag> dash </tag>  (NOT </strong> dash <strong> prose)
  w = w.replace(new RegExp("(<[a-z][^>/]*>\\s*)(?:" + emAlt + ")(\\s*)(</[a-z])", "gi"), "$1-$3");

  var BLOCK = "li|td|th|dt|dd|p|h[1-6]|title|figcaption|caption|blockquote";
  var reBlockOpen = new RegExp("<(" + BLOCK + ")[^>]*>", "gi");
  var EM_TEST = new RegExp(emAlt);

  w = w.replace(new RegExp("(\\s*)(?:" + emAlt + ")(\\s*)", "g"), function (match, _s1, _s2, offset, str) {
    var left = str.slice(Math.max(0, offset - 160), offset);
    var right = str.slice(offset + match.length, offset + match.length + 80);
    var last = null, m;
    reBlockOpen.lastIndex = 0;
    while ((m = reBlockOpen.exec(left)) !== null) last = m;
    var tag = null, inner = left;
    if (last) { tag = last[1].toLowerCase(); inner = left.slice(last.index + last[0].length); }
    var innerText = inner.replace(/<[^>]+>/g, " ").replace(/&#?\w+;/g, " ").trim();
    var words = innerText ? innerText.split(/\s+/).length : 0;
    var earlierDash = EM_TEST.test(inner);
    // COLON A: heading / title / caption subtitle
    if (tag && /^(title|h[1-6]|figcaption|caption)$/.test(tag)) return ": ";
    // COLON B: short label in list-item / table-cell / def-term, first dash, no sentence punct
    if (tag && /^(li|td|th|dt)$/.test(tag) && words <= 6 && !earlierDash && !/[.!?]/.test(innerText)) return ": ";
    // TRAILING: dash then end-of-block
    if (right.trim() === "" || /^\s*<\/(p|li|td|th|dd|dt|h[1-6]|blockquote)>/.test(right)) return "..";
    // DEFAULT: comma
    return ", ";
  });

  var reUnmask = new RegExp(S + "(\\d+)" + S, "g");
  return w.replace(reUnmask, function (_, i) { return masks[+i]; });
}
