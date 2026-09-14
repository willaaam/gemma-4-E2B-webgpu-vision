# Vendored Python packages (offline bundle)

Pure-Python wheels used by the **Code** app's Python runtime (Pyodide) so that a
curated set of popular packages installs with **no network connection**.

Generated — do not edit by hand. Re-generate with:

```bash
node tools/vendor-python-packages.mjs            # add/refresh missing wheels
node tools/vendor-python-packages.mjs --force    # re-download everything
node tools/vendor-python-packages.mjs --list     # show the curated set
```

## What is in here

* `*.whl` — pure-Python wheels (tagged `py3-none-any`, so they contain no
  compiled extensions and run unchanged in the browser's WASM CPython), together
  with the pure-Python transitive dependencies of the curated packages.
* `manifest.json` — machine-readable index used by
  `apps/code/runners/python-packages.js`: distribution name, version, short
  description, wheel filename, size, importable module names, requirements, and
  `externalRequires` (requirements intentionally **not** vendored because
  Pyodide ships them — numpy, pandas, matplotlib, scipy, scikit-learn,
  statsmodels). Also lists curated packages that could **not** be bundled because
  they publish no pure-Python wheel (those still install from PyPI when online).

## Curated packages

*General*: rich, tabulate, tqdm, python-dateutil, pytz, packaging, attrs,
more-itertools, toolz, beautifulsoup4, networkx, pyparsing, Pygments, chardet,
openpyxl, markdown, texttable, humanize, xmltodict, six.

*Data science*: seaborn, mlxtend, imbalanced-learn, yellowbrick, pingouin,
faker, arrow, numpy-financial, prettytable, xlsxwriter, natsort, glom, petl,
tzdata.

Packages that Pyodide already ships (numpy, pandas, matplotlib, scipy, sympy,
scikit-learn, …) are intentionally **not** vendored — they contain compiled code
and are loaded from the Pyodide distribution instead. When a bundled package
needs one of them, the app loads it automatically at install time (see
`externalRequires` above).

## How they are used

1. The **Packages** dialog in the Code app lists the bundled set with one-click
   *Install* (served from this folder over the same origin).
2. Running a Python file scans its imports; if a bundled package is imported but
   not loaded yet, its wheels are installed from here first, so `import rich`
   works offline.
3. `sw.js` caches this folder cache-first, and also caches `.whl` files fetched
   from PyPI, so packages installed while online keep working offline.

## Licensing

Each wheel is redistributed unmodified under its own license. Consult each
package's metadata (`unzip -p <wheel> '*.dist-info/METADATA'`) or its PyPI page
for the applicable terms.
