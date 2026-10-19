"""Paired edits to the manual's two layers — import this, do not hand-edit.

App owns public/manual/index.html (owner, 2026-10-19). It is NOT regenerable:
the rendered layer carries semantic image classes (statsym, terrsym, aff-mark,
skillsym, itemsym, treesym), figure variants, and hand-authored plates
(cf-imgwrap with SVG callouts, kbd-fig keycaps) that markdown cannot express.
Re-rendering a section from its markdown silently destroys all of it, so every
change is a surgical text edit applied to BOTH layers.

Usage: build a list of (section, html_old, html_new, md_old, md_new) and call
apply(). Pass md_old=None for changes that live only in hand-authored HTML.
Then run `node scripts/check-manual-drift.js`.

The booklet is stored twice — the rendered .prose HTML a reader sees, and the
manual-bodies JSON the inline editor loads. Editing one alone means the next
editor save silently reverts it, so every change here names BOTH forms and the
whole batch aborts if either side does not match. A partial application is the
one outcome worse than no application.
"""
import json
import pathlib
import re
import sys

P = pathlib.Path("public/manual/index.html")


def load():
    html = P.read_text(encoding="utf-8")
    m = re.search(r'(<script[^>]*id="manual-bodies"[^>]*>)(.*?)(</script>)', html, re.S)
    return html, json.loads(m.group(2).strip())


def save(html, bodies):
    m = re.search(r'(<script[^>]*id="manual-bodies"[^>]*>)(.*?)(</script>)', html, re.S)
    html = html[:m.start(2)] + json.dumps(bodies, ensure_ascii=False, indent=1) + html[m.end(2):]
    P.write_text(html, encoding="utf-8")


def apply(edits):
    """edits: list of (section, html_old, html_new, md_old, md_new).

    Pass md_old=None to leave the markdown untouched (for changes that live only
    in hand-authored HTML the markdown never carried).
    """
    html, bodies = load()
    problems, applied = [], 0

    for sec, h_old, h_new, m_old, m_new in edits:
        if sec not in bodies:
            problems.append(f"{sec}: unknown section")
            continue
        if h_old is not None:
            # Search OUTSIDE the manual-bodies blob. The file contains both
            # layers, so an anchor present in the prose AND the markdown matches
            # twice — and a careless replace would edit the JSON instead of the
            # HTML, which is the exact drift this module exists to prevent.
            jm = re.search(r'<script[^>]*id="manual-bodies"[^>]*>.*?</script>', html, re.S)
            head, blob, tail = html[:jm.start()], html[jm.start():jm.end()], html[jm.end():]
            hits = head.count(h_old) + tail.count(h_old)
            if hits != 1:
                problems.append(f"{sec}: HTML anchor matched {hits}x outside the JSON -> {h_old[:58]!r}")
            elif h_old in head:
                html = head.replace(h_old, h_new, 1) + blob + tail
                applied += 1
            else:
                html = head + blob + tail.replace(h_old, h_new, 1)
                applied += 1
        if m_old is not None:
            body = bodies[sec]
            if body.count(m_old) != 1:
                problems.append(f"{sec}: MD anchor matched {body.count(m_old)}x -> {m_old[:58]!r}")
            else:
                bodies[sec] = body.replace(m_old, m_new, 1)
                applied += 1

    if problems:
        print("  ABORTED — nothing written:")
        for p in problems:
            print("   ", p)
        return 1
    save(html, bodies)
    print(f"  applied {applied} edit(s) across both layers")
    return 0
