import { Box, Markdown, MouseRegion, Text, type Component } from "@earendil-works/pi-tui";
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";

export interface ResultDetails { receipt?: string; taskId?: string; title?: string; text?: string; explicit?: boolean }
/** The whole result card is a navigation target in fullscreen TUI. Dragging/scrolling remain untouched. */
export function resultCard(content: string, details: ResultDetails, theme: Theme, padding: number, open: () => Promise<void>, onError: (error: unknown) => void): Component {
  const box = new Box(padding, 1, line => theme.bg("customMessageBg", line));
  const title = details.title ?? "Subagent";
  box.addChild(new Text(theme.fg("accent", `↗ ${title}`), 0, 0));
  const text = details.text ?? (content.split("\n").slice(1).join("\n") || content);
  box.addChild(new Markdown(text, 0, 0, getMarkdownTheme(), { color: line => theme.fg("customMessageText", line) }));
  let navigating = false;
  return new MouseRegion(box, event => {
    if (event.type !== "click" || event.button !== "left" || event.shift || event.alt || event.ctrl) return;
    if (!navigating) {
      navigating = true;
      void open().catch(onError).finally(() => { navigating = false; });
    }
    return { handled: true, render: false };
  });
}
