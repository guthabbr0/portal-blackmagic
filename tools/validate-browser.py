"""Production GLSL regression harness in Chromium. Not a Three.js game playthrough.
Requires Playwright and a Chromium installation. On headless Linux run under Xvfb:
  xvfb-run -a python tools/validate-browser.py
Software-driver results establish correctness, not gaming-GPU performance.
"""
import json
import os
from pathlib import Path
import shutil
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
executable = os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('google-chrome')
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=executable, headless=not bool(os.environ.get('DISPLAY')), args=[
        '--no-sandbox', '--use-gl=angle', '--use-angle=gl', '--disable-gpu-sandbox', '--ignore-gpu-blocklist', '--enable-webgl',
    ], env={**os.environ, 'LIBGL_ALWAYS_SOFTWARE': '1'})
    page = browser.new_page(viewport={'width': 1040, 'height': 950})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    # Feed our own standalone test document; no navigation or network access is required.
    page.set_content((root/'GPU-CHECK.html').read_text())
    page.wait_for_function('window.testResults?.done === true', timeout=180000)
    report = page.evaluate('window.testResults')
    report['consoleErrors'] = errors
    report['scope'] = 'Production GLSL and BVH packer in Chromium WebGL 2, software GL; not the React/Three.js application'
    (root/'tests/generated/browser-results.json').write_text(json.dumps(report, indent=2))
    page.screenshot(path=str(root/'tests/generated/browser-check.png'), full_page=True)
    browser.close()
    print(json.dumps(report, indent=2))
    if report.get('error') or errors or not all(r['passed'] for r in report['results']):
        raise SystemExit(1)
