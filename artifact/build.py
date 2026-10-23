"""Builds the single-file Artifact edition of BLACKBOX.

The page uses artifact/backend.js (claude.ai accounts and the artifact database) instead of the
Firebase SDK and firebase-config.js. Usage: python3 artifact/build.py <output.html>
"""
import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
out = Path(sys.argv[1])

html = (root / "index.html").read_text()
css = (root / "styles.css").read_text()
backend = (root / "artifact" / "backend.js").read_text()
scripts = {name: (root / name).read_text() for name in ("icons.js", "ui.js", "changelog.js", "app.js", "notify.js", "board.js", "updates.js", "boot.js")}


def inline_script(code):
    return "<script>\n" + code.replace("</script", "<\\/script") + "</script>"


html = html.replace('<link rel="stylesheet" href="styles.css">', f"<style>\n{css}</style>")
firebase_scripts = re.compile(r'\s*<script src="https://www\.gstatic\.com/firebasejs/[^"]+"></script>')
assert len(firebase_scripts.findall(html)) == 3, "expected the three Firebase SDK scripts"
html = firebase_scripts.sub("", html)
html = html.replace('<script src="firebase-config.js"></script>', inline_script(backend))
for name, code in scripts.items():
    html = html.replace(f'<script src="{name}"></script>', inline_script(code))
# Only CDN libraries the Artifact page allows may stay external.
assert not re.search(r'<script[^>]+src="(?!https://cdn\.jsdelivr\.net/npm/)', html), "a script was not inlined"

# The installable-app files (manifest, icons, service worker) only exist on the hosted edition.
html = re.sub(r'\s*<link rel="(manifest|icon|apple-touch-icon)"[^>]*>|\s*<meta name="apple-mobile-web-app[^>]*>', "", html)

# The Artifact publisher adds its own document skeleton.
html = re.sub(r"<!doctype html>\s*|</?html[^>]*>\s*|</?head>\s*|</?body>\s*", "", html, flags=re.I)
html = re.sub(r'<meta charset[^>]*>\s*|<meta name="viewport"[^>]*>\s*', "", html)
out.write_text(html.strip() + "\n")
print(f"wrote {out} ({out.stat().st_size // 1024} KB)")
