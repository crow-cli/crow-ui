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
import { useWorkbenchFontSize } from "../lib/settings";
import tippy, { type Instance as TippyInstance } from "tippy.js";
import "tippy.js/dist/tippy.css";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { marked } from "marked";
import { DOMParser as ProseMirrorDOMParser } from "prosemirror-model";

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
          if (items.length === 0) return false;
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

  if (items.length === 0) {
    return (
      <div className="suggestions-popup">
        <div className="suggestion-item suggestion-no-results">No results</div>
      </div>
    );
  }

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
  workspaceRoot: string | null,
  openRef?: React.MutableRefObject<boolean>,
) {
  const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"]);

  return {
    char: "@",
    items: async ({ query }: { query: string }) => {
      const staticItems: PopupItem[] = [
        {
          id: "selection",
          label: "Selection",
          icon: "🎯",
          category: "Context",
        },
      ];

      if (!workspaceRoot) return staticItems;

      const q = query.trim();
      try {
        const { fsApi } = await import("../lib/rpc");
        const resp = await fsApi.searchFiles({ query: q, maxResults: 50 });
        const fileItems = resp.files.map((f) => {
          const ext = f.name.slice(f.name.lastIndexOf(".")).toLowerCase();
          const isImage = IMAGE_EXTS.has(ext);
          return {
            id: f.path,
            label: f.relativePath,
            icon: isImage ? "🖼️" : "📄",
            category: isImage ? "Images" : "Files",
          };
        });
        return [...staticItems, ...fileItems];
      } catch {
        return staticItems;
      }
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

interface JSONNode {
  type?: string;
  attrs?: Record<string, unknown>;
  text?: string;
  content?: JSONNode[];
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}

/** Convert inline marks to markdown syntax */
function applyMarks(text: string, marks?: JSONNode["marks"]): string {
  if (!marks || marks.length === 0) return text;
  // Apply marks in reverse order so nested marks work correctly
  for (const mark of [...marks].reverse()) {
    switch (mark.type) {
      case "bold":
        text = `**${text}**`;
        break;
      case "italic":
        text = `*${text}*`;
        break;
      case "code":
        text = `\`${text}\``;
        break;
      case "link": {
        const href = String(mark.attrs?.href ?? "");
        text = `[${text}](${href})`;
        break;
      }
      case "strike":
        text = `~~${text}~~`;
        break;
    }
  }
  return text;
}

/** Walk a TipTap JSON doc and produce ACP ContentBlocks.
 *  Preserves markdown formatting for all block-level nodes (lists, headings,
 *  blockquotes, code blocks) so the LLM sees structured text.
 */
function extractContentBlocks(doc: unknown): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  let currentText = "";

  const flushText = () => {
    if (currentText) {
      const trimmed = currentText.trimEnd();
      if (trimmed) {
        blocks.push({ type: "text", text: trimmed });
      }
      currentText = "";
    }
  };

  const appendText = (s: string) => {
    currentText += s;
  };

  /** Process inline nodes (text, hardBreak, mention, image) */
  const processInline = (nodes: JSONNode[] | undefined) => {
    for (const node of nodes ?? []) {
      switch (node.type) {
        case "text": {
          const text = applyMarks(node.text ?? "", node.marks);
          appendText(text);
          break;
        }
        case "hardBreak":
          appendText("\n");
          break;
        case "mention": {
          flushText();
          const id = String(node.attrs?.id ?? "");
          const label = String(node.attrs?.label ?? id);
          blocks.push({
            type: "resource_link",
            uri: `file://${id}`,
            name: label,
          });
          break;
        }
        case "image": {
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
          break;
        }
      }
    }
  };

  /** Process block-level nodes recursively */
  const processBlock = (node: JSONNode) => {
    switch (node.type) {
      case "paragraph": {
        processInline(node.content);
        appendText("\n\n");
        break;
      }
      case "heading": {
        const level = Math.min(Math.max((node.attrs?.level as number) ?? 1, 1), 6);
        appendText("#".repeat(level) + " ");
        processInline(node.content);
        appendText("\n\n");
        break;
      }
      case "bulletList": {
        for (const item of node.content ?? []) {
          if (item.type === "listItem") {
            appendText("- ");
            for (const child of item.content ?? []) {
              processBlock(child);
            }
            // Remove trailing \n\n from paragraph inside listItem,
            // replace with single \n
            currentText = currentText.trimEnd() + "\n";
          }
        }
        appendText("\n");
        break;
      }
      case "orderedList": {
        let num = (node.attrs?.start as number) ?? 1;
        for (const item of node.content ?? []) {
          if (item.type === "listItem") {
            appendText(`${num}. `);
            for (const child of item.content ?? []) {
              processBlock(child);
            }
            currentText = currentText.trimEnd() + "\n";
            num++;
          }
        }
        appendText("\n");
        break;
      }
      case "blockquote": {
        for (const child of node.content ?? []) {
          // Save state, process child, then prefix each line
          const saved = currentText;
          currentText = "";
          processBlock(child);
          const inner = currentText.trimEnd();
          currentText = saved;
          for (const line of inner.split("\n")) {
            if (line.trim()) {
              appendText("> " + line + "\n");
            }
          }
        }
        appendText("\n");
        break;
      }
      case "codeBlock": {
        const lang = String(node.attrs?.language ?? "");
        appendText("```" + lang + "\n");
        processInline(node.content);
        appendText("\n```\n\n");
        break;
      }
      case "horizontalRule": {
        appendText("---\n\n");
        break;
      }
      default: {
        // Unknown node — recurse into children
        for (const child of node.content ?? []) {
          processBlock(child);
        }
      }
    }
  };

  const root = doc as JSONNode;
  for (const node of root.content ?? []) {
    processBlock(node);
  }

  flushText();
  return blocks;
}

/** Read file contents for @-mentions and embed them as `resource` or `image` blocks.
 *  Falls back to `resource_link` if reading fails.
 *  Image files are read via the binary endpoint and sent as `image` blocks.
 */
async function embedMentionContent(
  blocks: ContentBlock[],
  _workspaceRoot: string | null,
): Promise<ContentBlock[]> {
  const result: ContentBlock[] = [];
  for (const block of blocks) {
    if (block.type === "resource_link" && block.uri?.startsWith("file://")) {
      const path = block.uri.slice("file://".length);
      const isImage = /\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)$/i.test(path);

      if (isImage) {
        // Read image as base64 via binary endpoint and send as image block
        try {
          const { fsApi } = await import("../lib/rpc");
          const resp = await fsApi.readFileBinary({ path });
          if (resp.data) {
            result.push({
              type: "image",
              mimeType: resp.mimeType,
              data: resp.data,
              uri: block.uri,
            });
            continue;
          }
        } catch {
          // Fall through to resource_link
        }
      } else {
        // Text file: embed as resource
        try {
          const content = await readFileContent(path);
          if (content != null) {
            result.push({
              type: "resource",
              resource: {
                uri: block.uri,
                text: content,
                mimeType: "text/plain",
              },
            });
            continue;
          }
        } catch {
          // Fall through to resource_link
        }
      }
    }
    result.push(block);
  }
  return result;
}

/** Heuristic: does this plain text look like markdown? */
function looksLikeMarkdown(text: string): boolean {
  // Check for block-level markdown patterns
  const patterns = [
    /^#{1,6}\s/m, // headings
    /^[-*+]\s/m, // bullet lists
    /^\d+\.\s/m, // ordered lists
    /^>\s/m, // blockquotes
    /^```/m, // code fences
    /\*\*[^*]+\*\*/, // bold
    /`[^`]+`/, // inline code
    /\[([^\]]+)\]\(([^)]+)\)/, // links
  ];
  return patterns.some((p) => p.test(text));
}

/** Convert markdown text to TipTap JSON using marked + ProseMirror DOMParser */
function markdownToTiptapJson(
  markdown: string,
  schema: import("prosemirror-model").Schema,
): object | null {
  try {
    const html = marked.parse(markdown, { async: false }) as string;
    const domParser = new globalThis.DOMParser();
    const dom = domParser.parseFromString(
      `<div>${html}</div>`,
      "text/html",
    );
    const doc = ProseMirrorDOMParser.fromSchema(schema).parse(dom.body.firstChild!);
    return doc.toJSON();
  } catch (e) {
    console.warn("[MessageEditor] markdown parse failed:", e);
    return null;
  }
}

// ─── MessageEditor Component ───────────────────────────────────────────────

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

  // Stable extension — suggestion queries backend on every keystroke
  const CustomMention = useMemo(() => {
    return Mention.extend({
      renderHTML({ node, HTMLAttributes }) {
        const label = node.attrs.label as string;
        const id = node.attrs.id as string;
        const isImage = /\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)$/i.test(id);
        const icon = id === "selection" ? "🎯" : isImage ? "🖼️" : "📄";
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
      suggestion: makeSuggestionConfig(workspaceRoot, suggestionOpenRef),
      HTMLAttributes: { class: "mention-chip" },
    });
  }, [workspaceRoot]);

  // Ref so the keyboard shortcut extension always calls the latest callback
  const handleSendRef = useRef(() => {});

  const SendOnEnter = useMemo(() => {
    return Extension.create({
      name: "sendOnEnter",
      addKeyboardShortcuts() {
        return {
          Enter: () => {
            if (suggestionOpenRef.current) return false;
            const editor = this.editor;
            if (!editor) return false;
            // Don't send if cursor is in a list, blockquote, or code block
            // — let StarterKit handle list continuation, code block exit, etc.
            if (
              editor.isActive("bulletList") ||
              editor.isActive("orderedList") ||
              editor.isActive("blockquote") ||
              editor.isActive("codeBlock")
            ) {
              return false;
            }
            handleSendRef.current();
            return true;
          },
          "Mod-Enter": () => {
            if (suggestionOpenRef.current) return false;
            handleSendRef.current();
            return true;
          },
          // Shift+Enter is intentionally NOT captured — let StarterKit's HardBreak
          // extension handle it (inserts <br> in lists, paragraphs, etc.)
        };
      },
    });
  }, []);

  const chatFontSize = useWorkbenchFontSize("chat");

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
      handlePaste: (view, event) => {
        const data = event.clipboardData;
        if (!data) return false;

        // Use the editor instance from the view (avoids stale closure)
        const editorInstance = (view as any)?.editor || editor;

        // 1. Images — highest priority
        // Try clipboardData.files first (works in most modern browsers + Electron)
        if (data.files && data.files.length > 0) {
          for (const file of data.files) {
            if (file.type.startsWith("image/")) {
              event.preventDefault();
              const reader = new FileReader();
              reader.onload = (e) => {
                const dataUrl = e.target?.result as string;
                if (dataUrl && editorInstance) {
                  editorInstance.chain().focus().setImage({ src: dataUrl }).run();
                }
              };
              reader.readAsDataURL(file);
              return true;
            }
          }
        }

        // Try clipboardData.items (standard API, sometimes has files when .files doesn't)
        const items = data.items;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item.type.startsWith("image/")) {
            const file = item.getAsFile();
            if (file) {
              event.preventDefault();
              const reader = new FileReader();
              reader.onload = (e) => {
                const dataUrl = e.target?.result as string;
                if (dataUrl && editorInstance) {
                  editorInstance.chain().focus().setImage({ src: dataUrl }).run();
                }
              };
              reader.readAsDataURL(file);
              return true;
            }
          }
        }

        // 2. HTML paste with images — let ProseMirror handle it
        const htmlText = data.getData("text/html");
        if (htmlText) {
          // Check if HTML contains images
          const hasImages = /<img\s/i.test(htmlText);
          if (hasImages) {
            // Let ProseMirror handle it — TipTap Image extension will pick up <img> tags
            return false;
          }
        }

        // 3. Markdown text paste — convert to rich text
        const plainText = data.getData("text/plain");
        if (plainText && !htmlText && looksLikeMarkdown(plainText)) {
          event.preventDefault();
          const json = markdownToTiptapJson(plainText, editorInstance?.view?.state?.schema);
          if (json) {
            editorInstance?.chain().focus().insertContent(json).run();
          } else {
            editorInstance?.chain().focus().insertContent(plainText).run();
          }
          return true;
        }

        // 4. HTML paste — let ProseMirror handle it natively
        if (htmlText) {
          return false;
        }

        // 5. Plain text paste — let default handler deal with it
        return false;
      },
      handleDrop: (view, event) => {
        const dt = event.dataTransfer;
        if (!dt) return false;

        // Use the editor instance from the view (avoids stale closure)
        const editorInstance = (view as any)?.editor || editor;

        // 1. OS file drop (images from file manager)
        const files = dt.files;
        if (files && files.length > 0) {
          event.preventDefault();
          for (const file of files) {
            if (file.type.startsWith("image/")) {
              const reader = new FileReader();
              reader.onload = (e) => {
                const dataUrl = e.target?.result as string;
                if (dataUrl && editorInstance) {
                  editorInstance.chain().focus().setImage({ src: dataUrl }).run();
                }
              };
              reader.readAsDataURL(file);
            } else {
              // Insert a file mention
              editorInstance
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
        }

        // 2. In-app drop from explorer (dataTransfer has text/plain path)
        const textPath = dt.getData("text/plain");
        if (textPath && textPath.startsWith(workspaceRoot || "")) {
          event.preventDefault();
          const isImage = /\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)$/i.test(textPath);
          if (isImage && editorInstance) {
            // Use binary endpoint to read image and embed as base64
            import("../lib/rpc").then(({ fsApi }) => {
              fsApi.readFileBinary({ path: textPath })
                .then((resp) => {
                  if (resp.data) {
                    const dataUrl = `data:${resp.mimeType};base64,${resp.data}`;
                    editorInstance.chain().focus().setImage({ src: dataUrl }).run();
                  }
                })
                .catch(() => {
                  // Fallback: mention the image file
                  editorInstance.chain().focus().insertContent({
                    type: "mention",
                    attrs: {
                      id: textPath,
                      label: textPath.split("/").pop() || textPath,
                      mentionSuggestionChar: "@",
                    },
                  }).run();
                });
            });
          } else {
            // Insert a file mention
            editorInstance
              ?.chain()
              .focus()
              .insertContent({
                type: "mention",
                attrs: {
                  id: textPath,
                  label: textPath.split("/").pop() || textPath,
                  mentionSuggestionChar: "@",
                },
              })
              .run();
          }
          return true;
        }

        return false;
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

  const handleSendClick = useCallback(async () => {
    if (!editor || disabled) return;
    const json = editor.getJSON();
    const blocks = extractContentBlocks(json);

    // Embed file content for @-mentions (fire-and-forget — editor clears immediately)
    const blocksWithContent = await embedMentionContent(blocks, workspaceRoot);

    // Defensive: check if we actually have content (not just empty paragraphs)
    const hasContent = blocksWithContent.some((b) => {
      if (b.type === "text") return (b.text || "").trim().length > 0;
      return true; // images, mentions, resources always count
    });
    if (!hasContent) return;

    // Extract plain text for editing queued messages later
    const text = blocksWithContent
      .map((b) =>
        b.type === "text"
          ? b.text
          : b.type === "image"
            ? "[Image]"
            : b.type === "resource"
              ? `[@${b.resource?.uri?.split("/").pop() ?? "file"}](embedded)`
              : b.type === "resource_link"
                ? `[@${b.name}](${b.uri})`
                : "",
      )
      .join("");

    onSend(blocksWithContent, text);
    editor.commands.clearContent();
  }, [editor, disabled, onSend, workspaceRoot]);

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
            "flex-1 rounded-md text-text-primary outline-none min-h-[120px] max-h-[320px] flex flex-col backdrop-blur-sm bg-secondary border border-border",
            disabled && "opacity-50 cursor-not-allowed"
          )}
          style={{ fontSize: chatFontSize }}
          onClick={() => !disabled && editor.chain().focus().run()}
        >
          <div
            ref={editorRef}
            className="flex-1 overflow-y-auto px-2.5 py-1.5"
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
            }}
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
