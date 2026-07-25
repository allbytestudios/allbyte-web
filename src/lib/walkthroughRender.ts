/**
 * walkthroughRender — a focused markdown→HTML renderer for the walkthrough
 * OVERLAY (owner's inline edits), run client-side so an edit shows live without
 * a rebuild.
 *
 * Scope is deliberately the PROSE subset an owner edits: paragraphs, **bold**,
 * *italic*, `code`, [links](url), > blockquotes (with the TO PROGRESS / Pro Tip
 * callout classing the remark plugin applies at build), `####`+ headings, `---`
 * rules, and - / 1. lists. Structural markdown that only Quinn authors — inline
 * ::shot embeds, tables, images — is NOT rendered here; such changes go through
 * her source, not an inline edit (see APP_CLAUDE_WALKTHROUGH_EDIT_OVERLAY.md).
 *
 * The base scene body still renders through Astro's full remark pipeline at
 * build; this only re-renders the handful of scenes an owner has overridden.
 */

import { normalizeDashes } from "../../scripts/dash-normalize.js";

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function inline(raw: string): string {
  let t = escapeHtml(raw);
  // order matters: code first (protects its contents), then links, bold, italic
  t = t.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
  t = t.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_m, txt, url) => `<a href="${url}" target="_blank" rel="noopener">${txt}</a>`
  );
  t = t.replace(/\*\*([^*]+)\*\*/g, (_m, b) => `<strong>${b}</strong>`);
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, (_m, pre, i) => `${pre}<em>${i}</em>`);
  t = t.replace(/(^|[^_\w])_([^_\n]+)_/g, (_m, pre, i) => `${pre}<em>${i}</em>`);
  return t;
}

function calloutClass(inner: string): string {
  const lead = (inner.match(/^\s*\*\*([^*]+)\*\*/) ?? [])[1] ?? "";
  if (/^TO PROGRESS/i.test(lead)) return ' class="wt-progress"';
  if (/pro\s*tip/i.test(lead)) return ' class="wt-tip"';
  return "";
}

const BLOCK_START = /^\s*(>|#{4,6}\s|[-*]\s|\d+\.\s|---+\s*$)/;

export function renderProse(md: string): string {
  const lines = (md ?? "").replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    if (/^\s*---+\s*$/.test(line)) { out.push("<hr>"); i++; continue; }

    const h = line.match(/^\s*(#{4,6})\s+(.*)$/);
    if (h) { const lv = h[1].length; out.push(`<h${lv}>${inline(h[2])}</h${lv}>`); i++; continue; }

    // blockquote — gather consecutive `>` lines
    if (/^\s*>/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      const inner = buf.join("\n");
      const paras = inner
        .split(/\n{2,}/)
        .map((p) => `<p>${inline(p.replace(/\n/g, " "))}</p>`)
        .join("");
      out.push(`<blockquote${calloutClass(inner)}>${paras}</blockquote>`);
      continue;
    }

    // unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      out.push(`<ul>${buf.map((li) => `<li>${inline(li)}</li>`).join("")}</ul>`);
      continue;
    }

    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      out.push(`<ol>${buf.map((li) => `<li>${inline(li)}</li>`).join("")}</ol>`);
      continue;
    }

    // paragraph — gather until a blank line or the next block starts
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !BLOCK_START.test(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p>${inline(buf.join(" "))}</p>`);
  }

  // House rule: no em-dashes (AI tell) — strip them from the rendered override HTML.
  return normalizeDashes(out.join("\n"));
}
