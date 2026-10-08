# price-list-site

Price List Sync – sales price site (test).

A scheduled one-way ETL pipeline: every 30 minutes the **Price Robot** (GitHub Actions) reads the private Master Sheet, keeps only 5 safe fields, encrypts them and publishes this site on GitHub Pages.

| Folder | What it is |
| --- | --- |
| `.github/workflows/price-robot.yml` | The schedule (every 30 min, UTC) and the manual **Run workflow** button |
| `robot/sync.py` | Reads the sheet, keeps 5 fields, encrypts |
| `docs/` | The website salespersons open (works offline, password once) |

Never upload the Google key file here. Keys and passwords live only in **Settings → Secrets and variables → Actions**.
