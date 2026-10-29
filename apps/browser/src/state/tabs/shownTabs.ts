import type { BrowserState } from "../browser/store";
import { activeTabId } from "../browser/model";
import { peekTabId } from "../peek/peek";
import { splitOf } from "../splits/splits";
import { holderOfPage } from "./pageSession";

export function shownTabIds(s: BrowserState): Set<string> {
  const shown = new Set<string>();
  for (const w of Object.values(s.windows)) {
    const id = activeTabId(s, w.id);
    if (!id) continue;
    shown.add(id);
    const peek = peekTabId(s, w.id);
    if (peek) shown.add(peek);
    const held = holderOfPage(s.tabs[id]);
    if (held) shown.add(held);
    for (const pane of splitOf(s, id)?.tabIds ?? []) shown.add(pane);
  }
  return shown;
}
