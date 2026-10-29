import { removeDownloadStaging, type Download } from "../../platform/downloads";
import { readDocument, writeDocument } from "../../platform/documents";
import { SESSION_DOCUMENT } from "./sessionDocument";
import { isAdoptKind } from "../tabs/adoptIds";
import { wakeOf } from "../tabs/pageSession";
import { useBrowser, type BrowserState, type HydrateData } from "../browser/store";
import { inPinnedContainer, isIncognitoProfile, snapshotTab } from "../browser/model";
import { earlyLaunchTabOn, launchTab, linkProfile } from "../tabs/launchTab";
import { launchBackdrop } from "../windows/launchBackdrop";
import { restoreLaunchLook, saveLaunchLook } from "../windows/launchLook";
import { parkWindowPins } from "../pins/parkedPins";
import { closedWindowEntry, MAX_CLOSED_WINDOWS } from "../pins/closedTabs";
import { isPeekTab } from "../peek/peek";
import type { AdoptId, BrowserWindow, Tab, TabPage, TabPin, TileFolder } from "../browser/types";
import { downloadSession } from "../downloads/downloadsSlice";
import { parseSaved, versionedJson, unchanged, type Migrations, type SavedObject } from "../../lib/savedDocument";
import { sessionWithCleanUpMinutes } from "../settings/cleanUpAfter";
import { sessionWithOwnTabMutes } from "../tabs/mute";
import { isRegularWindow } from "../windows/small";
import { isFields, isString, isStringList } from "../../lib/decode";

const SAVE_DELAY_MS = 800;
type SavedPage = Extract<TabPage, { kind: "idle" | "asleep" }>;
const SESSION_VERSION = 6;
const isRestoreId = (v: unknown): v is AdoptId => isString(v) && isAdoptKind(v, "restore");
const sessionWithTabPages = (doc: SavedObject): SavedObject => ({
  ...doc,
  tabs: Array.isArray(doc.tabs)
    ? doc.tabs.map((t: unknown) => {
        if (!isFields(t)) return t;
        const { navigation: _n, adoptId: _a, pageIn: _p, unloaded, wakeAdoptId, ...tab } = t;
        return { ...tab, page: { kind: unloaded === true ? "asleep" : "idle", ...(isRestoreId(wakeAdoptId) ? { wake: wakeAdoptId } : {}) } };
      })
    : doc.tabs,
});
const folderOf = (v: unknown): TileFolder | undefined =>
  isFields(v) && isString(v.id) && isString(v.name) ? { id: v.id, name: v.name, ...(typeof v.renamedAt === "number" ? { renamedAt: v.renamedAt } : {}) } : undefined;
const withPin = (t: unknown): unknown => {
  if (!isFields(t)) return t;
  const { pinned, pinnedAsRow, tileFolder, ...tab } = t;
  const folder = folderOf(tileFolder);
  return { ...tab, pin: pinned !== true ? null : pinnedAsRow === true ? { as: "row" } : folder ? { as: "tile", folder } : { as: "tile" } };
};
const pinFromDisk = (v: unknown): TabPin | null => {
  if (!isFields(v)) return null;
  if (v.as === "row") return { as: "row" };
  if (v.as !== "tile") return null;
  const folder = folderOf(v.folder);
  return folder ? { as: "tile", folder } : { as: "tile" };
};
const withPins = (list: unknown) => (Array.isArray(list) ? list.map(withPin) : list);
const entriesWith = (list: unknown, key: "tab" | "tabs") =>
  Array.isArray(list) ? list.map((e: unknown) => (isFields(e) && key in e ? { ...e, [key]: key === "tab" ? withPin(e.tab) : withPins(e.tabs) } : e)) : list;
const sessionWithTabPins = (doc: SavedObject): SavedObject => ({
  ...doc,
  tabs: withPins(doc.tabs),
  closedTabs: entriesWith(doc.closedTabs, "tab"),
  cleanedTabs: entriesWith(doc.cleanedTabs, "tab"),
  closedWindows: entriesWith(doc.closedWindows, "tabs"),
  closedGroups: entriesWith(doc.closedGroups, "tabs"),
  deletedGroups: entriesWith(doc.deletedGroups, "tabs"),
  parkedPins: isFields(doc.parkedPins) ? Object.fromEntries(Object.entries(doc.parkedPins).map(([p, park]) => [p, isFields(park) ? { ...park, tabs: withPins(park.tabs) } : park])) : doc.parkedPins,
});
const SESSION_MIGRATIONS: Migrations = { 2: sessionWithCleanUpMinutes, 3: sessionWithOwnTabMutes, 4: sessionWithTabPages, 5: sessionWithTabPins };
const downloadsWithStagingPathOnly = (doc: SavedObject): SavedObject => ({
  ...doc,
  downloads: Array.isArray(doc.downloads)
    ? doc.downloads.map((d: unknown) => {
        if (typeof d !== "object" || d === null) return d;
        const { stagingId: _id, destination: _to, ...kept } = d as SavedObject;
        return kept;
      })
    : doc.downloads,
});
const DOWNLOADS_VERSION = 3;
const DOWNLOADS_MIGRATIONS: Migrations = { 0: unchanged, 1: unchanged, 2: downloadsWithStagingPathOnly };

type Key = keyof BrowserState;
type Field<K extends Key, V> = { reads: readonly K[]; save: (s: Pick<BrowserState, K>) => V };
const field = <K extends Key, V>(reads: readonly K[], save: (s: Pick<BrowserState, K>) => V): Field<K, V> => ({ reads, save });

type Doc = { name: string; reads: readonly Key[]; json: (s: BrowserState) => string };

function doc<F extends Record<string, Field<Key, unknown>>>(name: string, version: number, fields: F): Doc {
  const entries = Object.entries(fields);
  return {
    name,
    reads: [...new Set(entries.flatMap(([, f]) => f.reads))],
    json: (s) => versionedJson(Object.fromEntries(entries.map(([key, f]) => [key, f.save(s)])), version),
  };
}

const publicTab = (t: { profileId: string }) => !isIncognitoProfile(t.profileId);
const publicProfiles = <T,>(byProfile: Record<string, T>) => Object.fromEntries(Object.entries(byProfile).filter(([profileId]) => publicTab({ profileId })));

const savedPage = (t: Tab): SavedPage => {
  const wake = wakeOf(t);
  const kind = t.page.kind === "asleep" || t.page.kind === "frozen" ? "asleep" : "idle";
  return isRestoreId(wake) && !isIncognitoProfile(t.profileId) ? { kind, wake } : { kind };
};
const persistedTab = (t: Tab) => ({ ...t, page: savedPage(t) });
const pageFromDisk = (v: unknown): SavedPage => {
  const page = isFields(v) ? v : {};
  const kind = page.kind === "asleep" ? "asleep" : "idle";
  return isRestoreId(page.wake) ? { kind, wake: page.wake } : { kind };
};

const savedWindows = (s: Pick<BrowserState, "windows">) =>
  Object.values(s.windows).filter(isRegularWindow).map(({ chromeWindow: _c, ...w }) => w);
const savedWindowIds = (s: Pick<BrowserState, "windows">) => new Set(savedWindows(s).map((w) => w.id));
const savedFocus = (s: Pick<BrowserState, "windows" | "ui">) => {
  const kept = savedWindowIds(s);
  return s.ui.focusOrder.find((id) => kept.has(id)) ?? null;
};

const SESSION_FIELDS = {
  profiles: field(["profiles"], (s) => s.profiles),
  profileOrder: field(["profileOrder"], (s) => s.profileOrder),
  orphanedProfileData: field(["orphanedProfileData"], (s) => s.orphanedProfileData),
  settings: field(["settings"], (s) => s.settings),
  windows: field(["windows"], savedWindows),
  windowOrder: field(["windows", "windowOrder"], (s) => s.windowOrder.filter((id) => savedWindowIds(s).has(id))),
  focusedWindowId: field(["windows", "ui"], savedFocus),
  lastProfileId: field(["ui"], (s) => s.ui.lastProfileId),
  launchTab: field(["windows", "tabs", "settings", "profiles", "ui"], (s) => (earlyLaunchTabOn() ? launchTab(s, savedFocus(s)) : null)),
  launchBackdrop: field(["windows", "profiles", "ui", "settings"], (s) => (earlyLaunchTabOn() ? launchBackdrop(s, savedFocus(s)) : null)),
  linkProfile: field(["windows", "profiles", "ui", "windowOrder", "settings"], (s) => (earlyLaunchTabOn() ? linkProfile(s) : null)),
  tabs: field(["windows", "tabs", "peeks"], (s) => {
    const kept = savedWindowIds(s);
    return Object.values(s.tabs).filter((t) => kept.has(t.windowId) && !isPeekTab(s, t.id)).map(persistedTab);
  }),
  groups: field(["windows", "groups"], (s) => Object.values(s.groups).filter((g) => savedWindowIds(s).has(g.windowId))),
  splits: field(["windows", "splits"], (s) => Object.values(s.splits).filter((v) => savedWindowIds(s).has(v.windowId))),
  closedTabs: field(["closedTabs"], (s) => s.closedTabs.filter((c) => publicTab(c.tab))),
  closedWindows: field(["closedWindows"], (s) => s.closedWindows.filter((c) => c.tabs.every(publicTab))),
  parkedPins: field(["parkedPins"], (s) => publicProfiles(s.parkedPins)),
  pinChoices: field(["pinChoices"], (s) => publicProfiles(s.pinChoices)),
  pinSync: field(["pinSync"], (s) => publicProfiles(s.pinSync)),
  closedGroups: field(["closedGroups"], (s) => s.closedGroups.filter((c) => c.tabs.every(publicTab))),
  deletedGroups: field(["deletedGroups"], (s) => s.deletedGroups.filter((c) => c.tabs.every(publicTab))),
  cleanedTabs: field(["cleanedTabs"], (s) => s.cleanedTabs.filter((c) => publicTab(c.tab))),
};

const DOWNLOADS_FIELDS = {
  downloads: field(["downloads", "profiles"], (s) =>
    s.downloads.filter((d) => downloadSession(s, d) === null).map((d) => (d.state === "downloading" ? { ...d, state: "failed" } : d)),
  ),
};

const DOCS: Doc[] = [doc("downloads.json", DOWNLOADS_VERSION, DOWNLOADS_FIELDS), doc(SESSION_DOCUMENT, SESSION_VERSION, SESSION_FIELDS)];

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isString) : []);
const has = (o: SavedObject, keys: readonly string[]) => keys.every((k) => isString(o[k]));
const rows = <T,>(v: unknown, ok: (o: SavedObject) => boolean): T[] => (Array.isArray(v) ? v.filter((o): o is SavedObject => isFields(o) && ok(o)) : []) as T[];
const byProfile = <T,>(v: unknown, ok: (o: SavedObject) => boolean = () => true): Record<string, T> =>
  (isFields(v) ? Object.fromEntries(Object.entries(v).filter(([, o]) => isFields(o) && ok(o))) : {}) as Record<string, T>;
const byId = <T extends { id: string }>(list: T[]) => Object.fromEntries(list.map((x) => [x.id, x]));
const nullableString = (v: unknown) => (isString(v) ? v : null);

const windowOk = (o: SavedObject) => has(o, ["id", "profileId"]) && isStringList(o.tabIds) && isFields(o.activeTabIds) && Object.values(o.activeTabIds).every(isString);
const tabOk = (o: SavedObject) => has(o, ["id", "windowId", "profileId", "url"]);
const groupOk = (o: SavedObject) => has(o, ["id", "windowId", "profileId"]) && isStringList(o.tabIds);
const splitOk = (o: SavedObject) => has(o, ["id", "windowId"]) && isStringList(o.tabIds) && Array.isArray(o.sizes);
const snapshotOk = (o: unknown) => isFields(o) && has(o, ["url", "profileId"]);
const closedTabOk = (o: SavedObject) => isString(o.id) && snapshotOk(o.tab);
const tabListOk = (o: SavedObject) => isString(o.id) && Array.isArray(o.tabs) && o.tabs.every(snapshotOk);
const profileOk = (o: SavedObject) => has(o, ["id", "name"]);
const parkedOk = (o: SavedObject) => Array.isArray(o.tabs) && o.tabs.every(snapshotOk) && Array.isArray(o.groups);

type SavedSession = Omit<HydrateData, "history" | "bookmarks" | "downloads"> & {
  windows: Record<string, BrowserWindow>;
  tabs: Record<string, Tab>;
};

export function parseSession(json: string | null | undefined): SavedSession | null {
  const raw = parseSaved(json, SESSION_VERSION, SESSION_MIGRATIONS);
  if (!raw) return null;
  return {
    profiles: byProfile(raw.profiles, profileOk),
    profileOrder: strings(raw.profileOrder),
    orphanedProfileData: strings(raw.orphanedProfileData),
    settings: isFields(raw.settings) ? (raw.settings as HydrateData["settings"]) : undefined,
    windows: byId(rows<BrowserWindow>(raw.windows, windowOk)),
    windowOrder: strings(raw.windowOrder),
    focusedWindowId: nullableString(raw.focusedWindowId),
    lastProfileId: nullableString(raw.lastProfileId),
    tabs: byId(rows<Tab>(raw.tabs, tabOk).map((t) => ({ ...t, page: pageFromDisk(t.page), pin: pinFromDisk(t.pin) }))),
    groups: byId(rows(raw.groups, groupOk)),
    splits: byId(rows(raw.splits, splitOk)),
    closedTabs: rows(raw.closedTabs, closedTabOk),
    closedWindows: rows(raw.closedWindows, tabListOk),
    parkedPins: byProfile(raw.parkedPins, parkedOk),
    pinChoices: byProfile(raw.pinChoices),
    pinSync: byProfile(raw.pinSync),
    closedGroups: rows(raw.closedGroups, tabListOk),
    deletedGroups: rows(raw.deletedGroups, tabListOk),
    cleanedTabs: rows(raw.cleanedTabs, closedTabOk),
  };
}

function read(name: string): string | null {
  try {
    return readDocument(name);
  } catch (error) {
    console.warn(`Couldn't read ${name}`, error);
    return null;
  }
}

function write(name: string, json: string) {
  try {
    writeDocument(name, json);
  } catch (error) {
    console.warn(`Couldn't save ${name}`, error);
  }
}

let droppedPrivateDownloads = false;

function forgetStaging(id: string) {
  const s = useBrowser.getState();
  const download = s.downloads.find((d) => d.id === id);
  if (!download) return;
  const { staging: _, ...kept } = download;
  s.upsertDownload(kept);
}

function savedDownloads(saved: Pick<BrowserState, "profiles">): Download[] {
  const raw = parseSaved(read("downloads.json"), DOWNLOADS_VERSION, DOWNLOADS_MIGRATIONS);
  const downloads = rows<Download>(raw?.downloads, (d) => isString(d.id) && isString(d.state));
  droppedPrivateDownloads = downloads.some((d) => downloadSession(saved, d) !== null);
  return downloads.filter((d) => downloadSession(saved, d) === null).map((d, i) => {
    const id = `saved-${i}`;
    const { staging, ...kept } = d;
    if (!staging || d.state === "downloading") return { ...kept, id };
    void removeDownloadStaging(staging)
      .catch(() => false)
      .then((removed) => removed && forgetStaging(id));
    return { ...d, id };
  });
}

function closedForLaunch(session: SavedSession): HydrateData {
  const now = Date.now();
  const pinSource = { tabs: session.tabs, groups: session.groups ?? {}, splits: session.splits ?? {}, history: {}, profiles: session.profiles ?? {} };
  let parkedPins = session.parkedPins ?? {};
  for (const w of Object.values(session.windows)) parkedPins = parkWindowPins(parkedPins, w, pinSource);
  const closedWindows = [
    ...(session.closedWindows ?? []),
    ...Object.values(session.windows)
      .map((w) =>
        closedWindowEntry(
          w,
          w.tabIds
            .map((id) => session.tabs[id])
            .filter((t): t is Tab => !!t && !inPinnedContainer(pinSource, t.id))
            .map((t) => ({ ...snapshotTab(t), active: Object.values(w.activeTabIds).includes(t.id) })),
          [],
          now,
        ),
      )
      .filter((c) => c.tabs.some((t) => t.url)),
  ].slice(-MAX_CLOSED_WINDOWS);
  return { ...session, parkedPins, closedWindows, windows: {}, windowOrder: [], tabs: {} };
}

export function loadSession(): HydrateData | null {
  const session = parseSession(read(SESSION_DOCUMENT));
  if (!session) return null;
  const downloads = savedDownloads({ profiles: session.profiles ?? {} });
  const data = session.settings?.restoreSession === false ? closedForLaunch(session) : session;
  return { ...data, downloads };
}

let flush: () => void = () => {};
let resume: () => void = () => {};
let frozen = false;

export function flushPersistence({ final = false } = {}) {
  flush();
  if (final && !frozen) saveLaunchLook(useBrowser.getState());
  if (final) frozen = true;
}

export function resumePersistence() {
  frozen = false;
  resume();
}

export function startPersistence() {
  useBrowser.getState().hydrate(loadSession() ?? {});
  restoreLaunchLook();

  const lastSources = new Map<string, unknown[]>();
  const lastJson = new Map<string, string>();
  const dirty = new Set<Doc>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const save = () => {
    clearTimeout(timer);
    timer = undefined;
    if (frozen) return;
    const s = useBrowser.getState();
    for (const doc of DOCS.filter((d) => dirty.has(d))) {
      const json = doc.json(s);
      if (lastJson.get(doc.name) !== json) {
        lastJson.set(doc.name, json);
        write(doc.name, json);
      }
    }
    dirty.clear();
  };
  flush = save;

  const check = (s: BrowserState, initial = false) => {
    if (frozen) return;
    for (const doc of DOCS) {
      const sources = doc.reads.map((key) => s[key]);
      const prev = lastSources.get(doc.name);
      if (prev && sources.every((v, i) => v === prev[i])) continue;
      lastSources.set(doc.name, sources);
      if (!initial) dirty.add(doc);
    }
    if (dirty.size && !timer) timer = setTimeout(save, SAVE_DELAY_MS);
  };
  check(useBrowser.getState(), true);
  if (droppedPrivateDownloads) {
    droppedPrivateDownloads = false;
    dirty.add(DOCS.find((d) => d.name === "downloads.json")!);
    timer ??= setTimeout(save, SAVE_DELAY_MS);
  }
  resume = () => {
    check(useBrowser.getState());
    save();
  };
  return useBrowser.subscribe((s) => check(s));
}
