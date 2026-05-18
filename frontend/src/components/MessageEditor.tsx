import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Mention from "@tiptap/extension-mention";
import Placeholder from "@tiptap/extension-placeholder";
import Image from "@tiptap/extension-image";
import { Extension } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import { Button } from "./ui/button";
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
import { cn } from "../lib/utils";
import tippy, { type Instance as TippyInstance } from "tippy.js";
import "tippy.js/dist/tippy.css";
import type { ContentBlock } from "@agentclientprotocol/sdk";

// ─── Types ─────────────────────────────────────────────────────────────────

interface SessionConfigOption {
  id: string;
  name: string;
  category?: string;
  currentValue?: string;
  options?: Array<{ name: string; description?: string; value: string }>;
}

interface MessageEditorProps {
  workspaceRoot: string | null;
  disabled: boolean;
  isStreaming?: boolean;
  placeholder: string;
  queuedCount?: number;
  configOptions?: SessionConfigOption[];
  draftText?: string;
  onSend: (blocks: ContentBlock[], text?: string) => void;
  onCancel?: () => void;
  onModelChange?: (modelValue: string) => void;
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
    char: "@",
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
    } else if (node.type === "hardBreak") {
      currentText += "\n";
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
  for (let i = 0; i < topLevel.length; i++) {
    const node = topLevel[i];
    if (node.type === "paragraph") {
      for (const inline of (node.content as JSONNode[] | undefined) ?? []) {
        processNode(inline);
      }
      // Add paragraph break between paragraphs (but not after last)
      if (i < topLevel.length - 1) {
        currentText += "\n\n";
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
  isStreaming,
  placeholder,
  queuedCount = 0,
  configOptions,
  draftText,
  onSend,
  onCancel,
  onModelChange,
}: MessageEditorProps) {
  const [mentionItems, setMentionItems] = useState<MentionItem[]>([]);
  const editorRef = useRef<HTMLDivElement>(null);
  const suggestionOpenRef = useRef(false);
  const lastDraftRef = useRef<string | undefined>(undefined);

  // Model config: find the option with category === "model"
  const modelConfig = configOptions?.find((c) => c.category === "model" || c.id === "model");
  const modelOptions = modelConfig?.options || [];
  const [selectedModel, setSelectedModel] = useState(modelConfig?.currentValue || "");

  // Sync selectedModel when configOptions change (new session)
  useEffect(() => {
    if (modelConfig?.currentValue) {
      setSelectedModel(modelConfig.currentValue);
    }
  }, [modelConfig?.currentValue]);

  // Build mention items from workspace files
  useEffect(() => {
    if (!workspaceRoot) {
      setMentionItems([]);
      mentionItemsRef.current = [];
      return;
    }

    const items: MentionItem[] = [
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

    // Fetch workspace files for @-mentions
    const root = workspaceRoot; // narrowed by guard above
    async function loadFiles() {
      try {
        const { fsApi } = await import("../lib/rpc");
        const resp = await fsApi.readDir({ path: root });
        const fileItems: MentionItem[] = [];
        for (const entry of resp.entries) {
          if (entry.isFile) {
            fileItems.push({
              id: entry.path,
              label: entry.name,
              icon: "📄",
              category: "Files",
              resolve: () => ({
                type: "resource_link",
                uri: `file://${entry.path}`,
                name: entry.name,
              }),
            });
          } else if (entry.isDir && !entry.name.startsWith(".") && entry.name !== "node_modules" && entry.name !== "target") {
            // One-level deep scan for directories
            try {
              const subResp = await fsApi.readDir({ path: entry.path });
              for (const sub of subResp.entries) {
                if (sub.isFile) {
                  fileItems.push({
                    id: sub.path,
                    label: `${entry.name}/${sub.name}`,
                    icon: "📄",
                    category: entry.name,
                    resolve: () => ({
                      type: "resource_link",
                      uri: `file://${sub.path}`,
                      name: sub.name,
                    }),
                  });
                }
              }
            } catch {
              // ignore subdir read errors
            }
          }
        }
        const all = [...items, ...fileItems];
        setMentionItems(all);
        mentionItemsRef.current = all.map((m) => ({
          id: m.id,
          label: m.label,
          icon: m.icon,
          category: m.category,
        }));
      } catch {
        // Fallback to default items on error
        setMentionItems(items);
        mentionItemsRef.current = items.map((m) => ({
          id: m.id,
          label: m.label,
          icon: m.icon,
          category: m.category,
        }));
      }
    }

    loadFiles();
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

  // Ref so the keyboard shortcut extension always calls the latest callback
  const handleSendRef = useRef(() => {});

  const SendOnEnter = useMemo(() => {
    return Extension.create({
      name: "sendOnEnter",
      addKeyboardShortcuts() {
        return {
          Enter: () => {
            if (suggestionOpenRef.current) return false;
            handleSendRef.current();
            return true;
          },
          "Mod-Enter": () => {
            if (suggestionOpenRef.current) return false;
            handleSendRef.current();
            return true;
          },
        };
      },
    });
  }, []);

  const editor = useEditor({
    extensions: [
      StarterKit,
      CustomMention,
      Image.configure({ allowBase64: true }),
      Placeholder.configure({ placeholder }),
      SendOnEnter,
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
      handleKeyDown: (view, event) => {
        // Wrap selected text with paired characters
        const WRAP_PAIRS: Record<string, string> = {
          "(": ")",
          '"': '"',
          "{": "}",
          "[": "]",
          "*": "*",
          "~": "~",
          "_": "_",
          "`": "`",
          "'": "'",
        };
        const close = WRAP_PAIRS[event.key];
        if (close) {
          const { from, to, empty } = view.state.selection;
          if (!empty && from !== to) {
            const selected = view.state.doc.textBetween(from, to);
            event.preventDefault();
            const tr = view.state.tr;
            tr.replaceWith(from, to, view.state.schema.text(event.key + selected + close));
            view.dispatch(tr);
            return true;
          }
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

  // Load draft text into editor when it changes (for editing queued messages)
  useEffect(() => {
    if (!editor || draftText === undefined) return;
    if (draftText === lastDraftRef.current) return;
    lastDraftRef.current = draftText;

    if (!draftText) {
      editor.commands.clearContent();
      return;
    }

    // Convert plain text to TipTap doc with paragraphs
    const paragraphs = draftText.split(/\n\n+/);
    const json = {
      type: "doc",
      content: paragraphs.map((p) => ({
        type: "paragraph",
        content: p ? [{ type: "text", text: p }] : [],
      })),
    };
    editor.commands.setContent(json);
    editor.commands.focus("end");
  }, [editor, draftText]);

  // Auto-scroll: keep cursor in view when typing at the bottom
  useEffect(() => {
    if (!editor || !editorRef.current) return;
    const container = editorRef.current;

    const handleUpdate = () => {
      const { state } = editor;
      const endPos = state.doc.content.size;
      const selEnd = state.selection.to;
      // Only auto-scroll if cursor is near the end
      if (selEnd < endPos - 2) return;

      requestAnimationFrame(() => {
        try {
          const coords = editor.view.coordsAtPos(selEnd);
          const containerRect = container.getBoundingClientRect();
          if (coords.bottom > containerRect.bottom - 8) {
            container.scrollTop = container.scrollHeight;
          }
        } catch {
          // coordsAtPos can fail on empty docs
        }
      });
    };

    editor.on("update", handleUpdate);
    return () => {
      editor.off("update", handleUpdate);
    };
  }, [editor]);

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
    // Extract plain text for editing queued messages later
    const text = blocks.map((b) => (b.type === "text" ? b.text : b.type === "image" ? "[Image]" : b.type === "resource_link" ? `@[${b.name}](${b.uri})` : "")).join("");
    onSend(blocks, text);
    editor.commands.clearContent();
  }, [editor, disabled, onSend]);

  const handleCancelClick = useCallback(() => {
    onCancel?.();
  }, [onCancel]);

  // Track whether editor has content to send (updates on every keystroke)
  const [hasEditorContent, setHasEditorContent] = useState(false);
  useEffect(() => {
    if (!editor) return;
    const checkContent = () => {
      const json = editor.getJSON();
      const blocks = extractContentBlocks(json);
      const has = blocks.some((b) => {
        if (b.type === "text") return (b.text || "").trim().length > 0;
        return true;
      });
      setHasEditorContent(has);
    };
    checkContent();
    editor.on("update", checkContent);
    return () => {
      editor.off("update", checkContent);
    };
  }, [editor]);

  // Keep ref in sync so keyboard shortcut extension calls latest handler
  handleSendRef.current = handleSendClick;

  if (!editor) return null;

  return (
    <div className="px-3 py-2 border-t border-border shrink-0 backdrop-blur-md bg-surface">
      <div className="flex gap-2 items-end">
        <div
          className={cn(
            "flex-1 rounded-md text-text-primary text-[13px] outline-none min-h-[120px] max-h-[320px] flex flex-col backdrop-blur-sm bg-secondary border border-border",
            disabled && "opacity-50 cursor-not-allowed"
          )}
          onClick={() => !disabled && editor.chain().focus().run()}
        >
          <div
            ref={editorRef}
            className="flex-1 overflow-y-auto px-2.5 py-1.5"
          >
            <EditorContent editor={editor} />
          </div>

          {/* Bottom bar: model selector (left) + send/cancel (right) */}
          <div className="shrink-0 flex items-center justify-between px-1.5 py-1">
            {/* Model selector */}
            {modelOptions.length > 0 && (
              <div>
                <select
                  value={selectedModel}
                  onChange={(e) => {
                    const val = e.target.value;
                    setSelectedModel(val);
                    onModelChange?.(val);
                  }}
                  disabled={disabled}
                  className="text-[11px] px-1.5 py-0.5 rounded border border-border cursor-pointer appearance-none pr-4 text-text-secondary bg-muted"
                  style={{
                    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8' viewBox='0 0 8 8'%3E%3Cpath fill='%23999' d='M0 2l4 4 4-4z'/%3E%3C/svg%3E")`,
                    backgroundRepeat: "no-repeat",
                    backgroundPosition: "right 4px center",
                  }}
                  title="Model"
                >
                  {modelOptions.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Send / Cancel button */}
            {/* When streaming: show stop if editor is empty, send if editor has content */}
            <Button
              variant={isStreaming && !hasEditorContent ? "destructive" : "default"}
              size="icon"
              className="w-7 h-7 text-[13px]"
              disabled={disabled && !isStreaming}
              onClick={isStreaming && !hasEditorContent ? handleCancelClick : handleSendClick}
            >
              {isStreaming && !hasEditorContent ? "⏹" : "➤"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
