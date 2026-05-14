import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Mention from "@tiptap/extension-mention";
import Placeholder from "@tiptap/extension-placeholder";
import Image from "@tiptap/extension-image";
import { ReactRenderer } from "@tiptap/react";
import {
  type SuggestionProps,
  type SuggestionKeyDownProps,
} from "@tiptap/suggestion";
import {
  useCallback,
  useEffect,
  useState,
  forwardRef,
  useRef,
  useMemo,
} from "react";
import tippy, { type Instance as TippyInstance } from "tippy.js";
import "tippy.js/dist/tippy.css";
import type { ContentBlock } from "@agentclientprotocol/sdk";

// ─── Types ─────────────────────────────────────────────────────────────────

interface MessageEditorProps {
  workspaceRoot: string | null;
  disabled: boolean;
  placeholder: string;
  onSend: (blocks: ContentBlock[]) => void;
}

interface MentionItem {
  id: string;
  label: string;
  icon: string;
  category: string;
  resolve: () => ContentBlock;
}

interface PopupItem {
  id: string;
  label: string;
  icon: string;
  category?: string;
  description?: string;
}

// ─── File reading helper ───────────────────────────────────────────────────

async function readFileContent(path: string): Promise<string | null> {
  try {
    const resp = await fetch(`/api/read_file?path=${encodeURIComponent(path)}`);
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.content ?? null;
  } catch {
    return null;
  }
}

// ─── Suggestion Popup Component ────────────────────────────────────────────

interface SuggestionPopupRef {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
}

const SuggestionPopup = forwardRef<
  SuggestionPopupRef,
  SuggestionProps<PopupItem>
>(function SuggestionPopup(props, ref) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const { items, command } = props;

  const selectItem = useCallback(
    (index: number) => {
      const item = items[index];
      if (item) {
        command({ id: item.id, label: item.label });
      }
    },
    [command, items],
  );

  useEffect(() => {
    setSelectedIndex(0);
  }, [items]);

  useEffect(() => {
    if (ref && typeof ref === "object") {
      (ref as React.MutableRefObject<SuggestionPopupRef>).current = {
        onKeyDown: ({ event }: SuggestionKeyDownProps) => {
          if (event.key === "ArrowUp") {
            setSelectedIndex((i) => (i + items.length - 1) % items.length);
            return true;
          }
          if (event.key === "ArrowDown") {
            setSelectedIndex((i) => (i + 1) % items.length);
            return true;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            selectItem(selectedIndex);
            return true;
          }
          return false;
        },
      };
    }
  }, [items, selectedIndex, selectItem, ref]);

  const grouped = items.reduce(
    (acc, item) => {
      const cat = item.category || "Items";
      if (!acc[cat]) acc[cat] = [];
      acc[cat].push(item);
      return acc;
    },
    {} as Record<string, PopupItem[]>,
  );

  return (
    <div className="suggestions-popup">
      {Object.entries(grouped).map(([category, catItems]) => (
        <div key={category}>
          <div className="suggestion-category">{category}</div>
          {catItems.map((item) => {
            const globalIdx = items.indexOf(item);
            return (
              <div
                key={item.id}
                className={`suggestion-item ${globalIdx === selectedIndex ? "is-selected" : ""}`}
                onClick={() => selectItem(globalIdx)}
                onMouseEnter={() => setSelectedIndex(globalIdx)}
              >
                <span className="suggestion-icon">{item.icon}</span>
                <span className="suggestion-label">{item.label}</span>
                {item.description && (
                  <span className="suggestion-desc">{item.description}</span>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
});

// ─── Suggestion Config Factory ─────────────────────────────────────────────

function makeSuggestionConfig(
  getItems: () => PopupItem[],
  openRef?: React.MutableRefObject<boolean>,
) {
  return {
    items: ({ query }: { query: string }) => {
      const allItems = getItems();
      const q = query.toLowerCase().trim();
      if (!q) return allItems.slice(0, 12);
      return allItems.filter(
        (item) =>
          item.label.toLowerCase().includes(q) ||
          item.id.toLowerCase().includes(q),
      ).slice(0, 12);
    },
    render: () => {
      let component: ReactRenderer<SuggestionPopupRef>;
      let popup: TippyInstance;
      return {
        onStart: (props: SuggestionProps<PopupItem>) => {
          if (openRef) openRef.current = true;
          component = new ReactRenderer(SuggestionPopup, {
            props,
            editor: props.editor,
          });
          popup = tippy("body", {
            getReferenceClientRect: props.clientRect as () => DOMRect,
            appendTo: () => document.body,
            content: component.element,
            showOnCreate: true,
            interactive: true,
            trigger: "manual",
            placement: "top-start",
            theme: "ide",
            popperOptions: {
              modifiers: [
                {
                  name: "preventOverflow",
                  options: { boundary: document.body },
                },
              ],
            },
          })[0];
        },
        onUpdate(props: SuggestionProps<PopupItem>) {
          component.updateProps(props);
          popup.setProps({
            getReferenceClientRect: props.clientRect as () => DOMRect,
          });
        },
        onKeyDown(props: SuggestionKeyDownProps) {
          return component.ref?.onKeyDown(props) ?? false;
        },
        onExit() {
          if (openRef) openRef.current = false;
          popup.destroy();
          component.destroy();
        },
      };
    },
  };
}

// ─── ContentBlock Extraction ───────────────────────────────────────────────

function extractContentBlocks(doc: unknown): ContentBlock[] {
  type JSONNode = {
    type?: string;
    attrs?: Record<string, unknown>;
    text?: string;
    content?: JSONNode[];
  };

  const root = doc as JSONNode;
  const blocks: ContentBlock[] = [];
  let currentText = "";

  const flushText = () => {
    if (currentText) {
      blocks.push({ type: "text", text: currentText });
      currentText = "";
    }
  };

  const processNode = (node: JSONNode) => {
    if (node.type === "text") {
      currentText += node.text ?? "";
    } else if (node.type === "mention") {
      flushText();
      const id = String(node.attrs?.id ?? "");
      const label = String(node.attrs?.label ?? id);
      // For now, file mentions become ResourceLink
      // In a fuller implementation, we'd read the file content and embed it
      blocks.push({
        type: "resource_link",
        uri: `file:///${id}`,
        name: label,
      });
    } else if (node.type === "image") {
      flushText();
      const src = String(node.attrs?.src ?? "");
      if (src.startsWith("data:")) {
        const match = src.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          blocks.push({
            type: "image",
            mimeType: match[1],
            data: match[2],
          });
        }
      } else {
        blocks.push({ type: "resource_link", uri: src, name: "Image" });
      }
    }
  };

  const topLevel = (root.content as JSONNode[] | undefined) ?? [];
  for (const node of topLevel) {
    if (node.type === "paragraph") {
      for (const inline of (node.content as JSONNode[] | undefined) ?? []) {
        processNode(inline);
      }
    } else {
      processNode(node);
    }
  }

  flushText();

  // Merge adjacent text blocks
  const merged: ContentBlock[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      const last = merged[merged.length - 1];
      if (last && last.type === "text") {
        (last as Extract<ContentBlock, { type: "text" }>).text += block.text;
      } else {
        merged.push(block);
      }
    } else {
      merged.push(block);
    }
  }
  return merged;
}

// ─── MessageEditor Component ───────────────────────────────────────────────

/** Stable mention items ref so suggestion config always reads current values */
const mentionItemsRef = { current: [] as PopupItem[] };

export default function MessageEditor({
  workspaceRoot,
  disabled,
  placeholder,
  onSend,
}: MessageEditorProps) {
  const [mentionItems, setMentionItems] = useState<MentionItem[]>([]);
  const editorRef = useRef<HTMLDivElement>(null);
  const suggestionOpenRef = useRef(false);

  // Build mention items from workspace files
  useEffect(() => {
    if (!workspaceRoot) {
      setMentionItems([]);
      mentionItemsRef.current = [];
      return;
    }
    // Default context types + files from workspace
    const items: MentionItem[] = [
      {
        id: "file",
        label: "File",
        icon: "📄",
        category: "Context",
        resolve: () => ({
          type: "resource_link",
          uri: "file:///",
          name: "File",
        }),
      },
      {
        id: "selection",
        label: "Selection",
        icon: "🎯",
        category: "Context",
        resolve: () => ({
          type: "resource_link",
          uri: "selection://",
          name: "Selection",
        }),
      },
    ];
    setMentionItems(items);
    mentionItemsRef.current = items.map((m) => ({
      id: m.id,
      label: m.label,
      icon: m.icon,
      category: m.category,
    }));
  }, [workspaceRoot]);

  // Stable extension that reads items from ref (not captured at creation time)
  const CustomMention = useMemo(() => {
    return Mention.extend({
      renderHTML({ node, HTMLAttributes }) {
        const label = node.attrs.label as string;
        const id = node.attrs.id as string;
        const item = mentionItems.find((m) => m.id === id);
        const icon = item?.icon ?? "🔗";
        return [
          "span",
          {
            ...HTMLAttributes,
            class: "mention-chip",
            "data-mention-id": id,
          },
          ["span", { class: "mention-icon" }, icon],
          ["span", { class: "mention-label" }, label],
        ];
      },
    }).configure({
      suggestion: makeSuggestionConfig(() => mentionItemsRef.current, suggestionOpenRef),
      HTMLAttributes: { class: "mention-chip" },
    });
  }, []); // stable — items function reads from ref

  const editor = useEditor({
    extensions: [
      StarterKit,
      CustomMention,
      Image.configure({ allowBase64: true }),
      Placeholder.configure({ placeholder }),
    ],
    content: "",
    editable: !disabled,
    editorProps: {
      handlePaste: (_view, event) => {
        const items = event.clipboardData?.items;
        if (!items) return false;
        for (const item of items) {
          if (item.type.startsWith("image/")) {
            const file = item.getAsFile();
            if (file) {
              event.preventDefault();
              const reader = new FileReader();
              reader.onload = (e) => {
                const dataUrl = e.target?.result as string;
                if (dataUrl) {
                  editor?.chain().focus().setImage({ src: dataUrl }).run();
                }
              };
              reader.readAsDataURL(file);
              return true;
            }
          }
        }
        return false;
      },
      handleDrop: (_view, event) => {
        const files = event.dataTransfer?.files;
        if (!files || files.length === 0) return false;
        event.preventDefault();
        for (const file of files) {
          if (file.type.startsWith("image/")) {
            const reader = new FileReader();
            reader.onload = (e) => {
              const dataUrl = e.target?.result as string;
              if (dataUrl) {
                editor?.chain().focus().setImage({ src: dataUrl }).run();
              }
            };
            reader.readAsDataURL(file);
          } else {
            // Insert a file mention
            editor
              ?.chain()
              .focus()
              .insertContent({
                type: "mention",
                attrs: {
                  id: file.name,
                  label: file.name,
                  mentionSuggestionChar: "@",
                },
              })
              .run();
          }
        }
        return true;
      },
      handleKeyDown: (_view, event) => {
        if (event.key === "Enter" && !event.shiftKey && !suggestionOpenRef.current) {
          event.preventDefault();
          handleSendClick();
          return true;
        }
        return false;
      },
    },
  }, [placeholder]);

  // Sync editable state after editor initializes (disabled prop may change before editor is ready)
  useEffect(() => {
    if (editor) {
      editor.setEditable(!disabled);
    }
  }, [editor, disabled]);

  const handleSendClick = useCallback(() => {
    if (!editor || disabled) return;
    const json = editor.getJSON();
    const blocks = extractContentBlocks(json);
    // Defensive: check if we actually have content (not just empty paragraphs)
    const hasContent = blocks.some((b) => {
      if (b.type === "text") return (b.text || "").trim().length > 0;
      return true; // images, mentions always count
    });
    if (!hasContent) return;
    onSend(blocks);
    editor.commands.clearContent();
  }, [editor, disabled, onSend]);

  if (!editor) return null;

  return (
    <div
      className="px-3 py-2 border-t flex gap-2 shrink-0 backdrop-blur-md"
      style={{
        backgroundColor: "var(--theme-chat-input-bg)",
        borderColor: "var(--theme-border)",
      }}
    >
      <div
        ref={editorRef}
        className={`flex-1 px-2.5 py-1.5 rounded-md text-text-primary text-[13px] outline-none min-h-[36px] max-h-[200px] overflow-y-auto backdrop-blur-sm ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
        style={{
          backgroundColor: "var(--theme-elevated-40)",
          border: "1px solid var(--theme-border)",
        }}
        onClick={() => !disabled && editor.chain().focus().run()}
      >
        <EditorContent editor={editor} />
      </div>
      <button
        onClick={handleSendClick}
        disabled={disabled}
        className="px-4 py-1.5 rounded font-semibold text-[13px] border-none self-end transition-all"
        style={
          !disabled
            ? {
                backgroundColor: "var(--theme-accent-80)",
                color: "var(--theme-text-inverse)",
                cursor: "pointer",
                boxShadow: "0 0 12px var(--theme-accent-faint)",
              }
            : {
                backgroundColor: "var(--theme-surface-50)",
                color: "var(--theme-text-secondary)",
                cursor: "default",
              }
        }
        onMouseEnter={(e) => {
          if (!disabled) {
            (e.currentTarget as HTMLButtonElement).style.backgroundColor = "var(--theme-accent)";
          }
        }}
        onMouseLeave={(e) => {
          if (!disabled) {
            (e.currentTarget as HTMLButtonElement).style.backgroundColor = "var(--theme-accent-80)";
          }
        }}
      >
        Send
      </button>
    </div>
  );
}
