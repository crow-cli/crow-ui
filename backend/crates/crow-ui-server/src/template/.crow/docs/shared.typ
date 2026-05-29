#let book-css = ":root {
  --bg: #faf9f7;
  --fg: #1c1917;
  --muted: #78716c;
  --accent: #b45309;
  --code-bg: #f5f5f4;
  --border: #e7e5e4;
  --sidebar-bg: #f5f5f4;
  --max-width: 680px;
}

* { box-sizing: border-box; }
html { scroll-behavior: smooth; }

body {
  font-family: 'Source Serif 4', Georgia, serif;
  font-size: 18px;
  line-height: 1.7;
  color: var(--fg);
  background: var(--bg);
  margin: 0;
}

.container {
  display: flex;
  max-width: 1200px;
  margin: 0 auto;
}

nav.toc {
  position: sticky;
  top: 0;
  height: 100vh;
  overflow-y: auto;
  width: 260px;
  padding: 2rem 1.5rem;
  background: var(--sidebar-bg);
  border-right: 1px solid var(--border);
  font-size: 14px;
  line-height: 1.5;
  font-family: system-ui, sans-serif;
}

nav.toc h2 {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
  margin: 0 0 1rem;
}

nav.toc ul { list-style: none; padding: 0; margin: 0; }
nav.toc li { margin-bottom: 0.4rem; }
nav.toc a {
  color: var(--fg);
  text-decoration: none;
  display: block;
  padding: 0.2rem 0;
}
nav.toc a:hover { color: var(--accent); }
nav.toc .active { color: var(--accent); font-weight: 600; }

nav.chapter-nav {
  display: flex;
  justify-content: space-between;
  padding: 1rem 0;
  margin-bottom: 2rem;
  border-bottom: 1px solid var(--border);
  font-family: system-ui, sans-serif;
  font-size: 14px;
}

nav.chapter-nav a {
  color: var(--accent);
  text-decoration: none;
}
nav.chapter-nav a:hover { text-decoration: underline; }

main.content {
  flex: 1;
  max-width: var(--max-width);
  padding: 3rem 4rem;
}

h1 {
  font-size: 2.2rem;
  font-weight: 700;
  margin: 0 0 0.5rem;
  letter-spacing: -0.02em;
  line-height: 1.2;
}

h2 {
  font-size: 1.5rem;
  font-weight: 600;
  margin: 2.5rem 0 1rem;
  padding-bottom: 0.3rem;
  border-bottom: 2px solid var(--border);
}

h3 {
  font-size: 1.15rem;
  font-weight: 600;
  margin: 2rem 0 0.75rem;
}

p { margin: 0 0 1.2rem; }

a { color: var(--accent); text-decoration: underline; text-underline-offset: 0.15em; }
a:hover { text-decoration: none; }

ul, ol { margin: 0 0 1.2rem; padding-left: 1.5rem; }
li { margin-bottom: 0.4rem; }

pre {
  background: var(--code-bg);
  padding: 1rem 1.2rem;
  border-radius: 6px;
  overflow-x: auto;
  font-family: 'JetBrains Mono', monospace;
  font-size: 14px;
  line-height: 1.5;
  margin: 0 0 1.2rem;
}

code {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.88em;
  background: var(--code-bg);
  padding: 0.15em 0.35em;
  border-radius: 3px;
}

pre code { background: none; padding: 0; }

blockquote {
  margin: 0 0 1.2rem;
  padding: 0.5rem 0 0.5rem 1.2rem;
  border-left: 3px solid var(--accent);
  color: var(--muted);
  font-style: italic;
}

blockquote .attribution {
  display: block;
  margin-top: 0.5rem;
  font-size: 0.9em;
  font-style: normal;
  color: var(--muted);
}

@media print {
  nav.toc { display: none; }
  nav.chapter-nav { display: none; }
  main.content { max-width: none; padding: 0; }
}

@media (max-width: 900px) {
  .container { display: block; }
  nav.toc { display: none; }
  main.content { padding: 1.5rem; }
}
.hero {
  text-align: center;
  padding: 4rem 0 3rem;
}
.hero h1 {
  font-size: 2.8rem;
  margin-bottom: 0.5rem;
}
.hero .subtitle {
  font-size: 1.25rem;
  color: var(--muted);
  font-style: italic;
  margin-bottom: 2rem;
}
.book-list {
  list-style: none;
  padding: 0;
  max-width: 600px;
  margin: 0 auto;
}
.book-list li {
  margin-bottom: 1.5rem;
  padding: 1.5rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: white;
}
.book-list a {
  font-size: 1.2rem;
  font-weight: 600;
  text-decoration: none;
  color: var(--fg);
}
.book-list a:hover { color: var(--accent); }
.book-list .desc {
  color: var(--muted);
  font-size: 0.95rem;
  margin-top: 0.3rem;
}
.journal-list {
  list-style: none;
  padding: 0;
  max-width: 600px;
  margin: 2rem auto 0;
}
.journal-list li {
  margin-bottom: 0.75rem;
  padding: 0.75rem 1rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: white;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.journal-list a {
  color: var(--fg);
  text-decoration: none;
  font-weight: 500;
}
.journal-list a:hover { color: var(--accent); }
.journal-list .date {
  color: var(--muted);
  font-size: 0.85rem;
  font-family: 'JetBrains Mono', monospace;
}
"

#let google-fonts = "@import url('https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,400;8..60,600;8..60,700&family=JetBrains+Mono:wght@400;500&display=swap');"

#let toc-item(text, url, active: false) = {
  let cls = if active { "active" } else { "" }
  html.elem("li")[
    #html.elem("a", attrs: (href: url, class: cls))[#text]
  ]
}

#let chapter-nav(prev: none, next: none) = html.elem("nav", attrs: (class: "chapter-nav"))[
  #if prev != none {
    html.elem("a", attrs: (href: prev.at("url")))[
      ← #prev.at("title")
    ]
  } else {
    html.elem("span")[]
  }
  #html.elem("a", attrs: (href: "../index.html"))[↑ Library]
  #if next != none {
    html.elem("a", attrs: (href: next.at("url")))[
      #next.at("title") →
    ]
  } else {
    html.elem("span")[]
  }
]
