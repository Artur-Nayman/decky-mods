import type { SupportedGame } from "./games";

// ---- Generic (user-configured) games -----------------------------------------
// ponytail: localStorage on this device; move to backend settings if it must
// survive a Decky reinstall.
const CUSTOM_KEY = "decky-mods.customGames";
export const GENERIC_NO_SCAN = "_decky_generic_none";

export function customGames(): Record<number, SupportedGame> {
  try {
    return JSON.parse(localStorage.getItem(CUSTOM_KEY) || "{}");
  } catch {
    return {};
  }
}

export function saveCustomGame(g: {
  appId: number;
  displayName: string;
  nexusDomain: string;
  installDirName: string;
  genericTarget: string;
}): void {
  const all = customGames();
  all[g.appId] = {
    ...g,
    modsSubdir: GENERIC_NO_SCAN,
    installMode: "generic",
    moddedSaveWarning: false,
    processName: "",
  };
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable: setup lasts this session only */
  }
}

export function removeCustomGame(appId: number): void {
  const all = customGames();
  delete all[appId];
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}
