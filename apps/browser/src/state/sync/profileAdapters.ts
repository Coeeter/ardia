import { canonical, type Adapter } from "../../platform/sync";
import { useBrowser } from "../browser/store";
import { DEFAULT_PROFILE_ID } from "../settings/settings";
import { sanitizeTheme } from "../../lib/profileLook";
import type { Profile, ProfileTheme } from "../browser/types";
import { PROFILE, PROFILE_THEME, SHARE, profileRecord } from "./records";

const store = () => useBrowser.getState();

export type ProfileRecord = { n: string; c: Profile["color"]; i: string | null; d?: true; th?: ProfileTheme | null };

export type ProfileThemeRecord = { t: ProfileTheme } | { preset: true };

export type ThemeAngleRecord = { a?: number; d?: number };

export const themeAngleKey = (syncId: string) => `${PROFILE_THEME}${syncId}:angle`;

function withoutAngles({ angle: _angle, dark, ...theme }: ProfileTheme): ProfileTheme {
  if (!dark) return theme;
  const { angle: _darkAngle, ...darkLook } = dark;
  return { ...theme, dark: darkLook };
}

function anglesOf(theme: ProfileTheme): ThemeAngleRecord {
  return { ...(theme.angle !== undefined ? { a: theme.angle } : {}), ...(theme.dark?.angle !== undefined ? { d: theme.dark.angle } : {}) };
}

export function themeFromRecord(record: unknown, angles?: unknown): Pick<Profile, "theme"> | null {
  if (!record || typeof record !== "object") return null;
  if ("preset" in record && record.preset === true) return { theme: null };
  const theme = "t" in record ? sanitizeTheme(record.t) : null;
  if (!theme) return null;
  if (!angles || typeof angles !== "object") return { theme };
  const { a, d } = angles as Record<string, unknown>;
  const look = withoutAngles(theme);
  return { theme: sanitizeTheme({ ...look, angle: a, ...(look.dark ? { dark: { ...look.dark, angle: d } } : {}) }) };
}

export function legacyThemeOf(record: ProfileRecord): Pick<Profile, "theme"> | null {
  const theme = record.th ? sanitizeTheme(record.th) : null;
  return theme ? { theme } : null;
}

export function profilesAdapter(links: () => Record<string, { syncId: string }>): Adapter {
  const linked = () => Object.entries(links()).filter(([id]) => store().profiles[id]);
  return {
    prefix: PROFILE,
    adoptRemoteOnJoin: true,
    extract: (_base, _queued, _now, known) => {
      const values = new Map<string, unknown>();
      const all = links();
      for (const [id, { syncId }] of linked()) {
        const p = store().profiles[id]!;
        const sharesSyncedData = !!p.dataId && p.dataId !== id && !!all[p.dataId] && !!store().profiles[p.dataId];
        if (sharesSyncedData && !known(`${SHARE}${syncId}`)) continue;
        values.set(`${PROFILE}${syncId}`, {
          n: p.name,
          c: p.color,
          i: p.icon,
          ...(id === DEFAULT_PROFILE_ID ? { d: true } : {}),
        } satisfies ProfileRecord);
      }
      const mine = new Set(values.keys());
      return { values, ignore: (key) => !mine.has(key) };
    },
    apply: (visible, changed, _base, records) => {
      for (const [id, { syncId }] of linked()) {
        const record = profileRecord(visible.get(`${PROFILE}${syncId}`));
        if (!record || !changed.has(`${PROFILE}${syncId}`)) continue;
        const legacy = store().profiles[id]!.theme === undefined && !records.known(`${PROFILE_THEME}${syncId}`) ? legacyThemeOf(record) : null;
        store().updateProfile(id, { name: record.n, icon: record.i });
        store().setProfileLook(id, { color: record.c, ...legacy });
      }
    },
  };
}

export function profileThemesAdapter(
  links: () => Record<string, { syncId: string; themeAdopting?: true }>,
  records: () => Record<string, { v: unknown }> | undefined,
  picks: Map<string, number> = new Map(),
): Adapter {
  const linked = () => Object.entries(links()).filter(([id]) => store().profiles[id]);
  const differs = (value: unknown, key: string, base: (key: string) => unknown) => canonical(value) !== canonical(base(key) ?? null);
  const unapplied = (key: string, base: (key: string) => unknown) => {
    const record = records()?.[key];
    return !!record && record.v !== null && differs(record.v, key, base);
  };
  const dropPick = (id: string, pick: number | undefined) => pick !== undefined && picks.get(id) === pick && picks.delete(id);
  return {
    prefix: PROFILE_THEME,
    adoptRemoteOnJoin: true,
    extract: (base, _queued, _now, known) => {
      const values = new Map<string, unknown>();
      const pickOf = new Map<string, [string, number]>();
      for (const [id, { syncId, themeAdopting }] of linked()) {
        const theme = store().profiles[id]!.theme;
        const key = `${PROFILE_THEME}${syncId}`;
        const angleKey = themeAngleKey(syncId);
        if (theme === undefined || themeAdopting) continue;
        const record: ProfileThemeRecord = theme ? { t: withoutAngles(theme) } : { preset: true };
        const angles: ThemeAngleRecord = theme ? anglesOf(theme) : {};
        const sendAngles = Object.keys(angles).length > 0 || known(angleKey);
        const pick = picks.get(id);
        if (!differs(record, key, base) && (!sendAngles || !differs(angles, angleKey, base))) dropPick(id, pick);
        if (!picks.has(id) && (unapplied(key, base) || unapplied(angleKey, base))) continue;
        values.set(key, record);
        if (sendAngles) values.set(angleKey, angles);
        if (pick !== undefined) for (const k of [key, angleKey]) pickOf.set(k, [id, pick]);
      }
      const mine = new Set(values.keys());
      const published = (keys: Set<string>) => {
        for (const key of keys) {
          const made = pickOf.get(key);
          if (made) dropPick(...made);
        }
      };
      return { values, ignore: (key) => !mine.has(key), published };
    },
    apply: (visible, changed) => {
      for (const [id, { syncId }] of linked()) {
        const angleKey = themeAngleKey(syncId);
        if (!changed.has(`${PROFILE_THEME}${syncId}`) && !changed.has(angleKey)) continue;
        const patch = themeFromRecord(visible.get(`${PROFILE_THEME}${syncId}`), visible.get(angleKey));
        if (!patch) continue;
        store().setProfileLook(id, patch);
      }
    },
  };
}
