// File icon mapping — Material Design Icons via Unicode/codepoint
// Uses a simple color + letter approach that works without external font loading

const FILE_COLORS: Record<string, string> = {
  // Languages
  rs: "#dea584", // Rust — orange
  ts: "#519aba", // TypeScript — blue
  tsx: "#519aba",
  js: "#cbcb41", // JavaScript — yellow
  jsx: "#cbcb41",
  py: "#3572A5", // Python — blue
  go: "#00ADD8", // Go — cyan
  java: "#b07219", // Java — brown
  c: "#555555", // C — gray
  cpp: "#f34b7d", // C++ — pink
  cs: "#178600", // C# — green
  rb: "#701516", // Ruby — dark red
  swift: "#F05138", // Swift — red
  kt: "#A97BFF", // Kotlin — purple
  php: "#777BB4", // PHP — purple
  hs: "#5e5086", // Haskell — purple
  lua: "#000080", // Lua — navy
  r: "#198CE7", // R — blue
  dart: "#00B4AB", // Dart — teal
  ex: "#6e4a7e", // Elixir — purple
  clj: "#db5855", // Clojure — red
  scala: "#c22d40", // Scala — red
  // Web
  html: "#e34c26", // HTML — orange
  css: "#563d7c", // CSS — purple
  scss: "#c6538c", // SCSS — pink
  less: "#1d365d", // Less — dark blue
  // Data
  json: "#cbcb41", // JSON — yellow
  yaml: "#cb171e", // YAML — red
  yml: "#cb171e",
  toml: "#9c4221", // TOML — brown
  xml: "#0060ac", // XML — blue
  sql: "#e38c00", // SQL — orange
  csv: "#237346", // CSV — green
  // Config
  sh: "#89e051", // Shell — green
  bash: "#89e051",
  zsh: "#89e051",
  env: "#ecd53f", // Env — yellow
  // Docs
  md: "#083fa1", // Markdown — blue
  txt: "#89e051", // Text — green
  log: "#89e051", // Log — green
  // Other
  lock: "#6e4a7e", // Lock — purple
  gitignore: "#f34f29", // Git — orange
  dockerfile: "#384d54", // Docker — dark
  makefile: "#4a4a4a", // Make — gray
  wasm: "#654ff0", // WASM — purple
  svg: "#ffb13b", // SVG — orange
  png: "#a074c4", // PNG — purple
  jpg: "#a074c4",
  jpeg: "#a074c4",
  gif: "#a074c4",
};

const FILE_LABELS: Record<string, string> = {
  rs: "R", ts: "TS", tsx: "TS", js: "JS", jsx: "JS",
  py: "Py", go: "Go", java: "J", c: "C", cpp: "C+",
  cs: "C#", rb: "Rb", swift: "S", kt: "Kt", php: "PHP",
  hs: "Hs", lua: "Lua", r: "R", dart: "Dt", ex: "Ex",
  clj: "Clj", scala: "Sc", html: "<>", css: "{}",
  scss: "{}", less: "{}", json: "{ }", yaml: "Y",
  yml: "Y", toml: "T", xml: "<>", sql: "SQL", csv: "CSV",
  sh: "$", bash: "$", zsh: "$", env: "Env",
  md: "M", txt: "T", log: "L", lock: "🔒",
  gitignore: "Gi", dockerfile: "Dk", makefile: "Mk",
  wasm: "W", svg: "Sv", png: "P", jpg: "J", jpeg: "J", gif: "G",
};

interface FileIconProps {
  name: string;
  isDir?: boolean;
  size?: number;
}

export function FileIcon({ name, isDir = false, size = 14 }: FileIconProps) {
  if (isDir) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
        <path d="M10 4H4C2.89543 4 2 4.89543 2 6V18C2 19.1046 2.89543 20 4 20H20C21.1046 20 22 19.1046 22 18V8C22 6.89543 21.1046 6 20 6H12L10 4Z" fill="#d4c4ff" opacity="0.7" />
      </svg>
    );
  }

  const ext = name.split(".").pop()?.toLowerCase() || "";
  const color = FILE_COLORS[ext] || "#8b7bb5";
  const label = FILE_LABELS[ext] || "•";

  return (
    <span style={{
      width: size,
      height: size,
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      fontSize: size * 0.7,
      fontWeight: 700,
      color,
      fontFamily: "monospace",
      flexShrink: 0,
      lineHeight: 1,
    }}>
      {label}
    </span>
  );
}

// Simple string icon for use in plain text contexts
export function getFileIcon(name: string, isDir = false): string {
  if (isDir) return "📁";
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const labels: Record<string, string> = {
    rs: "🦀", py: "🐍", js: "🟨", ts: "🔷", jsx: "⚛️", tsx: "⚛️",
    go: "🔵", java: "☕", c: "🔵", cpp: "🔵", cs: "🟪",
    css: "🎨", html: "🌐", json: "📋", md: "📝", yaml: "📋", yml: "📋",
    sh: "⬛", bash: "⬛", zsh: "⬛", toml: "⚙️",
    lock: "🔒", gitignore: "🚫", dockerfile: "🐳", svg: "🖼️",
  };
  return labels[ext] || "📄";
}
