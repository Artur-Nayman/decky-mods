// Shared install path used by the mod detail page, the requirements
// batch installer, and the Updates section - so every entry point routes
// a mod through the identical per-game pipeline.
import {
  installFrostyMod,
  setFrostyModEnabled,
  setModEnabled,
  uninstallFrostyMod,
  uninstallMod,
  InstallResult,
  getModFiles,
  installFomod,
  installMod,
  prefetchModFile,
  prepareModFile,
  matchFileToGame,
  getGameBinaryVersion,
  getAuthStatus,
  getNxmQueue,
  registerNxmHandler,
} from "./api";
import { Navigation } from "@decky/ui";
import { SupportedGame, modeParams, stalenessExemptModIds } from "./games";
import { nameDownload } from "./state";
import { toaster } from "@decky/api";
import { addLaunchOptions, joinSteamBeta } from "./steam";

/** Move a game to the Steam beta its mods are made for (RE2's dx11_non-rt)
 * and say so, because Steam now downloads the difference and the next
 * launch waits for it. Called by Step 1 and by collection installs. */
export async function switchToModBeta(game: SupportedGame): Promise<void> {
  if (!game.steamBeta) return;
  if (await joinSteamBeta(game.appId, game.steamBeta.name)) {
    toaster.toast({
      title: `${game.displayName}: switching to ${game.steamBeta.label}`,
      body: "Steam downloads the change before the next launch.",
      duration: 12000,
    });
  }
}

/** Download AND extract a pinned file so the installer only has to
 * commit it. Extraction is the CPU-bound half of an install and shares
 * nothing, so running it for the next mods while the current one commits
 * is free wall-clock. The commit itself stays serial and in order. */
export async function preparePinned(
  game: SupportedGame,
  modId: number,
  fileId: number,
  fileName: string,
  modName: string
): Promise<void> {
  nameDownload(modId, modName, game.appId);
  try {
    await prepareModFile(game.nexusDomain, modId, fileId, fileName);
  } catch {
    // Best-effort: the installer does the work itself and owns the
    // error reporting for this mod's row.
  }
}

/** Download a pinned file into the backend's archive cache ahead of its
 * serial install - the collection pipeline runs several of these in
 * parallel so the network never idles while other mods extract. */
export async function prefetchPinned(
  game: SupportedGame,
  modId: number,
  fileId: number,
  fileName: string,
  modName: string
): Promise<void> {
  nameDownload(modId, modName, game.appId);
  try {
    await prefetchModFile(game.nexusDomain, modId, fileId, fileName);
  } catch {
    // Best-effort: the installer retries the download itself and
    // surfaces the real error on the mod's own row.
  }
}

/** Complete a FOMOD install after the wizard. */
export async function finishFomod(
  token: string,
  selectedIds: string[]
): Promise<InstallResult> {
  return installFomod(token, selectedIds);
}

/** Install a SPECIFIC pinned file (collections pin exact file ids).
 * Same pipeline, same Downloads-panel tracking. */
export async function installPinned(
  game: SupportedGame,
  modId: number,
  fileId: number,
  fileName: string,
  modName: string,
  version = "",
  collectionSlug = "",
  payloadChoice = "",
  /** Restore missing files only - never overwrite what's on disk. Used
   * by the collection repair pass; see installModWith. */
  repairOnly = false
): Promise<InstallResult> {
  nameDownload(modId, modName, game.appId);
  return installModWith(
    game,
    modId,
    fileId,
    fileName,
    modName,
    version,
    "collection",
    "",
    collectionSlug,
    payloadChoice,
    repairOnly
  );
}

// ponytail: premium cached per session; signing in/out mid-session needs a reload.
let premium: Promise<boolean> | undefined;
const isPremium = () =>
  (premium ??= getAuthStatus()
    .then((a) => !!a.is_premium)
    .catch(() => true)); // unknown: try the Premium path, its error is clearer

/** Free accounts: the user taps "Mod Manager Download" on the real page and
 * the website mints a one-file key in an nxm:// link, which the relay queues.
 * Polls for that exact file; null after 3 minutes. */
export async function waitForFreeDownloadKey(
  domain: string,
  modId: number,
  fileId: number
): Promise<{ key: string; expires: string } | null> {
  await registerNxmHandler();
  await getNxmQueue(true); // stale links from earlier taps
  Navigation.NavigateToExternalWeb(
    `https://www.nexusmods.com/${domain}/mods/${modId}?tab=files&file_id=${fileId}`
  );
  toaster.toast({
    title: "Tap \"Mod Manager Download\"",
    body: "Free account: the download starts once you tap it on the page.",
  });
  // ponytail: 1.5s polling of a file; inotify if this ever matters
  for (const end = Date.now() + 180_000; Date.now() < end; ) {
    await new Promise((r) => setTimeout(r, 1500));
    const hit = (await getNxmQueue(false)).entries?.find(
      (e) =>
        e.game_domain === domain &&
        e.mod_id === modId &&
        e.file_id === fileId &&
        e.key
    );
    if (hit) {
      await getNxmQueue(true);
      toaster.toast({ title: "Got it", body: "You can close the browser." });
      return hit;
    }
  }
  return null;
}

/** The ONE place that decides how a mod gets installed for a given game.
 *
 * Exported so pages call this instead of the api underneath it. The mod page
 * once duplicated this branch and My Mods skipped it entirely, and both times
 * Battlefront II quietly took the folder path. */
export async function installModWith(
  game: SupportedGame,
  modId: number,
  fileId: number,
  fileName: string,
  modName: string,
  version: string,
  source: string,
  pageVersion = "",
  collectionSlug = "",
  payloadChoice = "",
  repairOnly = false
): Promise<InstallResult> {
  if (game.frostbite) {
    // Frostbite games compile rather than copy: one call that converts the
    // mod and recompiles the enabled set. Routed here, at the single point
    // every install path already passes through, so the mod page, the
    // collection flow and Update all all get it without their own branch.
    return installFrostyMod(
      game.nexusDomain,
      modId,
      fileId,
      fileName,
      modName,
      version,
      game.installDirName,
      game.appId,
      pageVersion,
      payloadChoice
    );
  }

  let dl = { key: "", expires: "" };
  // ponytail: asks even when the archive is already cached; skip-on-cache if that annoys
  if (!(await isPremium())) {
    const got = await waitForFreeDownloadKey(game.nexusDomain, modId, fileId);
    if (!got) {
      return {
        ok: false,
        error: "No download link arrived from the Nexus Mods page.",
      };
    }
    dl = got;
  }

  return installMod(
    game.nexusDomain,
    modId,
    fileId,
    fileName,
    modName,
    version,
    game.installDirName,
    // Generic games: the real target for the install only; everything else
    // gets modsSubdir, a folder that never exists (see GENERIC_NO_SCAN).
    game.installMode === "generic" ? game.genericTarget ?? "" : game.modsSubdir,
    dl.key,
    dl.expires,
    ...modeParams(game),
    payloadChoice,
    game.ue4ss?.modsSubdir ?? "",
    game.ue4ss?.logicModsSubdir ?? "",
    game.launcherXmlSubpath ?? "",
    game.flatModExtensions ?? [],
    pageVersion,
    source,
    game.witcherLayout ?? false,
    collectionSlug,
    game.cp77Layout ?? false,
    game.pakPatchLayout ?? false,
    repairOnly,
    // Loaders are exempt from the built-for-an-older-patch rule: they load
    // other dlls rather than patching game code, so a game update does not
    // age them out.
    stalenessExemptModIds(game),
    game.hd2Layout ?? false,
    game.reshade?.subdir ?? "",
    game.processName ?? "",
    game.palSchema?.modsSubdir ?? "",
    game.monolithArchiveExt ?? ""
  ).then((result) => {
    // A proxy-dll mod does nothing under Proton until its dll is
    // overridden. Applied here, where every install path passes, and
    // merged so whatever the player already had stays.
    if (result.ok && result.launch_overrides) {
      addLaunchOptions(
        game.appId,
        `WINEDLLOVERRIDES="${result.launch_overrides}" %command%`
      );
    }
    return result;
  });
}

/** Install the other REQUIRED files of a mod whose page splits it in two.
 *
 * Runs after the main install, inside install.ts so every path gets it: the
 * mod page, a collection, an update. Each part installs under its own file
 * name, because the two halves use different install mechanisms (a Data/
 * folder mod and a game-root files mod) and one record cannot describe
 * both - and because "Engine Fixes - SKSE64 Preloader" in My Mods says
 * exactly what it is.
 *
 * Returns the names installed, for the caller to mention. Failures are
 * reported, never thrown: the main mod is already in place and a half
 * install the user is told about beats an exception they cannot read.
 */
export async function installCompanionFiles(
  game: SupportedGame,
  modId: number,
  chosenFileName: string
): Promise<{ installed: string[]; failed: string[] }> {
  const declared = game.companionFiles?.[modId];
  const done = { installed: [] as string[], failed: [] as string[] };
  if (!declared || declared.length === 0) return done;

  // Entries are strings or { pattern, untilGame }. untilGame retires a
  // companion from a game version onward: Engine Fixes' beta says the
  // preloader is "no longer required" from 1.7.99, so shipping it there
  // would be installing something the author tells users not to have.
  const entries = declared.map((e) =>
    typeof e === "string" ? { pattern: e, untilGame: undefined } : e
  );
  let gameVersion: string | undefined;
  if (entries.some((e) => e.untilGame) && game.processName) {
    gameVersion = await getGameBinaryVersion(
      game.installDirName,
      game.processName
    )
      .then((r) => r.version || undefined)
      .catch(() => undefined);
  }
  const versionAtLeast = (have: string, bound: string) => {
    const a = have.split(".").map(Number);
    const b = bound.split(".").map(Number);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i] ?? 0;
      const y = b[i] ?? 0;
      if (x !== y) return x > y;
    }
    return true;
  };
  const patterns = entries
    .filter(
      (e) =>
        !e.untilGame ||
        // Unknown game version keeps the companion: everywhere below the
        // bound it is REQUIRED, and a missing required file kills the game
        // while a retired one merely idles.
        !gameVersion ||
        !versionAtLeast(gameVersion, e.untilGame)
    )
    .map((e) => e.pattern);
  if (patterns.length === 0) return done;

  const chosen = chosenFileName.toLowerCase();
  // An All-In-One build already contains every part; so does the part
  // itself, if that is what the user picked.
  if (
    chosen.includes("all-in-one") ||
    chosen.includes("all in one") ||
    patterns.some((p) => chosen.includes(p.toLowerCase()))
  ) {
    return done;
  }

  const files = (await getModFiles(game.nexusDomain, modId)).files ?? [];
  for (const pattern of patterns) {
    const needle = pattern.toLowerCase();
    // Newest match wins, same rule as everywhere else on a mod page.
    const match = files
      .filter(
        (f) =>
          f.category_name === "MAIN" &&
          `${f.name} ${f.file_name}`.toLowerCase().includes(needle)
      )
      .sort((a, b) => b.file_id - a.file_id)[0];
    if (!match) {
      done.failed.push(pattern);
      continue;
    }
    nameDownload(modId, match.name, game.appId);
    const result = await installModWith(
      game,
      modId,
      match.file_id,
      match.file_name,
      // Its own name, so it is its own record and its own My Mods row.
      match.name,
      match.version || "",
      // source "companion": this record FOLLOWS its parent. The Updates tab
      // must never offer it alone - applying that went through the page's
      // default file logic and picked a different file entirely.
      "companion",
      match.version || ""
    );
    (result.ok ? done.installed : done.failed).push(match.name);
  }
  return done;
}

/** Install a mod's primary (latest main) file through the full pipeline.
 * Registers the download so the QAM Downloads panel tracks it. Returns
 * the InstallResult (needs_choice archives are surfaced to the caller). */
export async function installLatest(
  game: SupportedGame,
  modId: number,
  modName: string,
  pageVersion = "",
  payloadChoice = ""
): Promise<InstallResult> {
  const files = await getModFiles(game.nexusDomain, modId);
  let file = files.files?.[0];
  // When a file on the page names the installed game's version, that file
  // is the author answering "which build do I need" - Engine Fixes 7.0.20
  // loads on a 1.7.99 game and then dies wanting an address library file
  // that will never exist, while the page carries a 7.0.21 "for Skyrim AE
  // 1.7.99" build. Updates flow through here too, so a version-matched mod
  // updates to its game's build rather than the newest.
  if (game.processName) {
    const matched = await matchFileToGame(
      game.nexusDomain,
      modId,
      game.installDirName,
      game.processName
    ).catch(() => undefined);
    if (matched?.file_id) {
      file = files.files?.find((f) => f.file_id === matched.file_id) ?? file;
    }
  }
  if (!file) {
    return { ok: false, error: "No downloadable file found" };
  }
  nameDownload(modId, modName, game.appId);
  const result = await installModWith(
    game,
    modId,
    file.file_id,
    file.file_name,
    modName,
    file.version || pageVersion,
    "",
    pageVersion,
    "",
    payloadChoice
  );
  // Companions ride along here too, so collection installs and the Updates
  // tab bring a mod's other required halves - the mod page has its own
  // afterInstall, but nothing else did.
  if (result.ok) {
    await installCompanionFiles(game, modId, file.file_name);
  }
  return result;
}

/** Toggle a mod, whichever mechanism the game uses.
 *
 * Frostbite games have no per-mod switch: enabling or disabling anything
 * recompiles the whole enabled set, which takes a minute or two. Everything
 * else moves a folder. Callers should not have to know which.
 */
export async function toggleMod(
  game: SupportedGame,
  folder: string,
  enabled: boolean,
  reason?: string
): Promise<{ ok: boolean; error?: string }> {
  if (game.frostbite) {
    return setFrostyModEnabled(
      game.nexusDomain,
      folder,
      enabled,
      game.installDirName,
      game.appId
    );
  }

  return setModEnabled(
    game.installDirName,
    game.modsSubdir,
    folder,
    enabled,
    game.installMode ?? "folder",
    game.nexusDomain,
    game.appId,
    game.pluginsTxtSubpath ?? "",
    game.pluginsTxtStyle ?? "starred",
    reason ?? ""
  );
}

/** Remove a mod, whichever mechanism the game uses. */
export async function removeMod(
  game: SupportedGame,
  folder: string
): Promise<{ ok: boolean; error?: string }> {
  if (game.frostbite) {
    return uninstallFrostyMod(
      game.nexusDomain,
      folder,
      game.installDirName,
      game.appId
    );
  }

  return uninstallMod(
    game.nexusDomain,
    game.installDirName,
    game.modsSubdir,
    folder,
    game.installMode ?? "folder",
    game.appId,
    game.pluginsTxtSubpath ?? "",
    game.pluginsTxtStyle ?? "starred"
  );
}
