import { useEffect, useRef, useState } from "react";

export interface MenuAction {
  label: string;
  action: string;
  shortcut?: string;
  separator?: boolean;
  enabled?: boolean;
}

export interface MenuGroup {
  label: string;
  items: (MenuAction | { separator: true; label?: string; action?: string })[];
}

interface MenuBarProps {
  items: MenuGroup[];
  onAction: (action: string) => void;
  onOpenChange: (menu: string | null) => void;
}

export function MenuBar({ items, onAction, onOpenChange }: MenuBarProps) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
        onOpenChange(null);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onOpenChange]);

  const handleMenuClick = (label: string) => {
    const isOpen = openMenu === label;
    setOpenMenu(isOpen ? null : label);
    onOpenChange(isOpen ? null : label);
  };

  const handleAction = (action: string) => {
    setOpenMenu(null);
    onOpenChange(null);
    onAction(action);
  };

  return (
    <div
      ref={menuRef}
      className="h-8 bg-background/80 backdrop-blur-md flex items-center px-3 gap-1 border-b border-border shrink-0 relative z-[100] select-none"
    >
      {items.map((menu) => (
        <div key={menu.label} className="relative">
          <button
            className={`px-3 py-1 text-[13px] font-normal border-none cursor-pointer text-text-accent transition-colors rounded-sm hover:bg-hover hover:text-text-primary ${
              openMenu === menu.label
                ? "bg-hover text-text-primary"
                : "bg-transparent"
            }`}
            onClick={() => handleMenuClick(menu.label)}
            onMouseEnter={() => {
              if (openMenu && openMenu !== menu.label) {
                setOpenMenu(menu.label);
                onOpenChange(menu.label);
              }
            }}
          >
            {menu.label}
          </button>
          {openMenu === menu.label && (
            <div
              ref={dropdownRef}
              style={{ paddingLeft: '12px', paddingRight: '12px' }}
              className="absolute top-full left-0 min-w-[240px] bg-popover border border-border py-1.5 z-[200] rounded-md shadow-[0_4px_16px_rgba(0,0,0,0.4)]"
            >
              {menu.items.map((item, i) =>
                item.separator ? (
                  <div key={i} className="h-px bg-border/50 my-2" />
                ) : (
                  <button
                    key={item.label}
                    className={`flex items-center justify-between w-full text-left text-[13px] text-popover-foreground bg-transparent border-none transition-colors py-[5px] hover:bg-hover hover:text-text-primary rounded-sm ${
                      item.enabled === false ? "opacity-40 cursor-default" : "cursor-pointer"
                    }`}
                    onClick={() =>
                      item.enabled !== false && handleAction(item.action)
                    }
                  >
                    <span className="flex-1">{item.label}</span>
                    {item.shortcut && (
                      <span className="text-[11px] text-text-secondary ml-auto pl-6 font-mono">
                        {item.shortcut}
                      </span>
                    )}
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
