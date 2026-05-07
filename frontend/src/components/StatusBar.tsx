interface StatusBarProps {
  connected: boolean;
  saving: boolean;
  dirty: boolean;
  language: string;
  line: number;
  col: number;
  encoding: string;
  lineEnding: string;
  wordWrap: boolean;
  workspaceName: string;
}

export function StatusBar({
  connected,
  saving,
  dirty,
  language,
  line,
  col,
  encoding,
  lineEnding,
  wordWrap,
  workspaceName,
}: StatusBarProps) {
  return (
    <div
      className={`h-[22px] flex items-center px-2 text-[12px] text-white shrink-0 font-medium flex-nowrap ${
        workspaceName
          ? "bg-[var(--color-statusbar-workspace)]"
          : "bg-[var(--color-active)]"
      }`}
    >
      <div className="flex items-center gap-1">
        <StatusBarItem>
          {connected ? "✓" : "○"}{" "}
          {saving ? "Saving…" : workspaceName || "No Folder"}
        </StatusBarItem>
        {dirty && <StatusBarItem>●</StatusBarItem>}
      </div>
      <div className="flex items-center gap-[2px] ml-auto">
        <StatusBarItem>
          Ln {line}, Col {col}
        </StatusBarItem>
        <StatusBarItem>Spaces: 4</StatusBarItem>
        <StatusBarItem>{encoding}</StatusBarItem>
        <StatusBarItem>{lineEnding}</StatusBarItem>
        {wordWrap && <StatusBarItem>Word Wrap</StatusBarItem>}
        <StatusBarItem>{language}</StatusBarItem>
      </div>
    </div>
  );
}

function StatusBarItem({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 h-[22px] flex items-center cursor-pointer text-[12px] whitespace-nowrap hover:bg-[var(--color-primary)]/80 transition-colors">
      {children}
    </div>
  );
}
