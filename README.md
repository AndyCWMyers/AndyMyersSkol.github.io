# Andrew C. W. Myers's Academic Website

Published at https://www.andrewcwmyers.com/ from `main` using GitHub Pages.

## Site Files

- `index.html`, `style.css`, and `script.js`: homepage, styling, and navigation.
- Root PDFs: current papers, appendices, and CV. Preserve filenames so existing
  links keep working, including direct links from outside the homepage.
- `myers.jpg`, `images/`, and `favicon.ico`: public image assets.
- `_config.yml`, `Gemfile`, and `Gemfile.lock`: Jekyll build configuration.
- `_analytics/`: the Cloudflare Worker, PDF.js viewer, migrations, and tests.
  See [_analytics/README.md](_analytics/README.md) for the analytics workflow.

## Local Preview

With Ruby and Bundler installed:

```sh
bundle install
bundle exec jekyll serve
```

Generated `_site/`, Sass/Jekyll caches, installed gems under `vendor/bundle/`,
and machine-local files are intentionally ignored. Do not commit them.
The PDF.js assets in `_analytics/viewer-assets/` are deployable application
dependencies and must remain tracked, along with their licenses.
