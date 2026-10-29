import { layout } from "../ui/theme";
import { currentSettings } from "../../state/browser/current";
import type { DragSource } from "../../state/drag/drops";
import { descendantGroupIds, resolveDropNow } from "../../state/sidebar/current";
import { tabDragOutside } from "../../state/drag/tabDrag";
import { dragMarksOf, markDrag } from "../../state/sidebar/dragMarks";
import { folderPanel } from "../../state/sidebar/tileFolderUi";
import { overPins, pinGridHeight } from "./pinZone";
import { boxed, type Drop, FOLDER_HOLD_MS, folderOf, inside, type Item, pinnedBlock, ROW_GAP, spring } from "./dragModel";
import { aimAt, type Pointing } from "./dragZones";
import { DragGeometry } from "./dragGeometry";
import { hapticTick } from "../../state/drag/dragNative";
import { entryKey } from "../../state/sidebar/entryKey";

export class DragTargeting extends DragGeometry {
  protected clearHold() {
    clearTimeout(this.holdTimer);
    this.holdTimer = undefined;
    this.holdKey = null;
    this.holdReady = null;
  }

  protected holdOver(target: Item) {
    if (this.holdKey === target.key) return;
    this.clearHold();
    this.holdKey = target.key;
    if (folderOf(target)) return void (this.holdReady = target.key);
    this.holdTimer = setTimeout(() => {
      if (this.holdKey !== target.key || !this.sources.length) return;
      this.holdReady = target.key;
      this.retarget();
    }, FOLDER_HOLD_MS);
  }

  protected retarget() {
    const { x, y } = this.pointer;
    const source = this.sources[0]!;
    const sourceKeys = new Set(this.sources.map((s) => s.key));
    const subtree = source.kind === "group" ? new Set([source.groupId, ...descendantGroupIds(source.groupId)]) : null;
    const live = [...this.items.values()].filter(
      (i) => !sourceKeys.has(i.key) && i.frame && !(subtree && ((i.parentGroup && subtree.has(i.parentGroup)) || (i.kind === "group" && subtree.has(i.groupId)))),
    );
    const cy = (i: Item) => {
      const f = this.shown(i);
      return f.y + Math.min(f.h, i.headerFrame?.h ?? f.h) / 2;
    };
    const byY = (a: Item, b: Item) => this.at(a.frame, this.still(a))!.y - this.at(b.frame, this.still(b))!.y || a.frame!.x - b.frame!.x;
    const dragged = new Set(this.sources.flatMap((s) => s.tabIds));
    const firstTab = (i: Item | undefined) => i?.tabIds.find((id) => !dragged.has(id)) ?? null;
    const tabsDrag = source.kind === "row" || source.kind === "tile";
    const count = this.external || (folderOf(source) ? 1 : dragged.size);
    const rowPitch = (boxed(source) ? source.foldedHeight() : layout.rowHeight * (source.kind === "split" ? 1 : Math.max(1, this.ghost?.count ?? this.external ?? 1))) + ROW_GAP;
    const blocks = live.filter(pinnedBlock).sort(byY);
    const moved = this.sources
      .filter((s) => s.frame)
      .sort(byY)
      .flatMap((s) => (s.kind === "group" || s.kind === "live" || s.kind === "split" ? [s.key] : s.tabIds.map((id) => entryKey("tab", id))));
    const dragSource: DragSource = {
      kind: source.kind === "group" || source.kind === "split" || source.kind === "live" ? source.kind : "tab",
      groupId: source.kind === "group" ? source.groupId : undefined,
      folderId: folderOf(source),
      external: !!this.external,
    };

    const sidebar = this.viewport ?? this.rootFrame;
    const tiles = this.at(this.regionFrames.get("tiles") ?? null, this.tilesFixed);
    const balanced = currentSettings().balancedTopApps;
    const away = x > sidebar.x + sidebar.w + 40 || x < sidebar.x - 40 || tabDragOutside();
    const cells = live.filter((i) => i.kind === "tile").sort(byY);
    const overTiles = !away && tabsDrag && !!tiles && (this.gridBase ? overPins(y, this.pinFloor(live, tiles), this.pinning) : inside(tiles, x, y, 6));
    if (this.gridBase)
      this.gridGrowth = Math.min(pinGridHeight(cells.length + (overTiles ? count : 0), this.gridBase.w, layout.pinnedHeight, balanced), this.tilesFixed ? this.tilesRoom : Infinity) - this.gridBase.h;
    const list = this.at(this.regionFrames.get("list") ?? null);
    const panel = folderPanel();
    const panelFrame = panel ? (this.regionFrames.get("folder") ?? null) : null;
    const wasAway = dragMarksOf(this.marks).folderAway;
    const inPanel = !away && !wasAway && tabsDrag && !this.external && !!panelFrame && inside(panelFrame, x, y);
    const folderAway = source.section === "folder" && !inPanel;
    const canFolder = tabsDrag && !this.external && !folderOf(source);
    const home = source.section === "tiles" && source.frame ? cells.filter((c) => byY(c, source) < 0).length : null;
    const spot = !away && tabsDrag && overTiles && tiles ? this.pointed(tiles, cells, count, home, x, y, canFolder) : null;
    const target = spot?.part === "centre" ? spot.cell : null;
    if (target) this.holdOver(target);
    else this.clearHold();

    const pointing: Pointing = {
      x,
      y,
      source,
      live,
      cy,
      byY,
      firstTab,
      tabsDrag,
      external: !!this.external,
      blocks,
      moved,
      away,
      inPanel,
      held: target && this.holdReady === target.key ? target : null,
      overTiles,
      tiles,
      spot,
      cells,
      count,
      balanced,
      grid: !!this.gridBase,
      inPinned: !!list && y < list.y,
      kept: { gapKey: this.gapKey, pitch: this.pitch },
      shown: (i) => this.shown(i),
      at: (f) => this.at(f),
      ontoTarget: (section) => this.ontoTarget(live, y, section),
      overPinnedRows: () => this.overPinnedRows(y),
      leadTab: (key) => this.items.get(key)!.tabIds[0]!,
    };
    const aim = aimAt(pointing);
    const resolved = resolveDropNow(dragSource, aim.spot);
    const drop: Drop = resolved.type !== "none" && aim.sequence ? { ...resolved, sequence: aim.sequence } : resolved;
    const dropped = drop.type !== "none";
    const gapKey = dropped ? aim.gapKey : null;
    const pitch = aim.pitch ?? rowPitch;
    const into = dropped ? (aim.into ?? null) : null;
    const onto = drop.type === "onto" ? (aim.onto ?? null) : null;
    const folderTarget = aim.folderTarget ?? null;

    if (folderAway !== dragMarksOf(this.marks).folderAway) markDrag(this.marks, { folderAway });
    const key = JSON.stringify(drop);
    if (key === this.dropKey && gapKey === this.gapKey) return;
    if (this.dropKey && drop.type !== "none" && currentSettings().tabReorderHaptics) hapticTick();
    this.dropKey = key;
    this.drop = drop;
    this.into = into;
    const pins = drop.type === "tabs" && drop.placement.pinned && !drop.placement.row;
    const held = drop.type === "folder" && !inPanel;
    markDrag(this.marks, { dropInto: into, onto, folderTarget, pins: pins || held, pinCount: pins || held ? count : 0, pinBefore: pins || held ? gapKey : null });
    if (gapKey !== this.gapKey) {
      const prev = this.gapKey && this.items.get(this.gapKey);
      if (prev && !this.inGrid(prev)) spring(prev.gap, 0).start();
      const next = gapKey && this.items.get(gapKey);
      if (next && !this.inGrid(next)) spring(next.gap, pitch).start();
      this.gapKey = gapKey;
      this.pitch = pitch;
    }
  }
}
