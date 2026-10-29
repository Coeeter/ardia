import { canonical, pullSettled, type ScopeState } from "../../platform/sync";
import { useBrowser } from "../browser/store";
import type { Profile } from "../browser/types";
import { legacyThemeOf, themeAngleKey, themeFromRecord } from "./profileAdapters";
import { PROFILE, PROFILE_THEME, profileRecord } from "./records";
import type { ProfileLink } from "./syncDoc";

function pairedTheme(app: ScopeState, syncId: string): Pick<Profile, "theme"> | null {
  const record = app.records[`${PROFILE_THEME}${syncId}`]?.v;
  if (record) return themeFromRecord(record, app.records[themeAngleKey(syncId)]?.v);
  const profile = profileRecord(app.records[`${PROFILE}${syncId}`]?.v);
  return profile ? legacyThemeOf(profile) : null;
}

function settledTheme(app: ScopeState, syncId: string): boolean {
  const record = app.records[`${PROFILE_THEME}${syncId}`]?.v;
  return !!record && !!themeFromRecord(record);
}

export function pairTheme(app: ScopeState, profileId: string, link: ProfileLink) {
  const theme = pairedTheme(app, link.syncId);
  if (theme) useBrowser.getState().setProfileLook(profileId, theme);
  if (settledTheme(app, link.syncId)) delete link.themeAdopting;
  else link.themeAdopting = true;
}

export function settleAppliedThemes(profiles: Record<string, ProfileLink>, app: ScopeState | undefined) {
  if (!app) return;
  for (const link of Object.values(profiles)) {
    if (!link.themeAdopting) continue;
    const key = `${PROFILE_THEME}${link.syncId}`;
    const record = app.records[key]?.v;
    if (record && themeFromRecord(record) && app.base[key] === canonical(record)) delete link.themeAdopting;
  }
}

export function confirmThemes(profiles: Record<string, ProfileLink>, app: ScopeState) {
  settleAppliedThemes(profiles, app);
  if (!pullSettled(app)) return;
  for (const link of Object.values(profiles)) {
    if (!link.themeAdopting) continue;
    const record = app.records[`${PROFILE_THEME}${link.syncId}`];
    if (!record || record.v === null) delete link.themeAdopting;
  }
}
