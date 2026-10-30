// Setup for a game the plugin has no config for: pick the Nexus game and the
// folder mods merge into. Saved per device; the game then behaves like a
// supported one with the "generic" install mode.
import {
  ButtonItem,
  Field,
  PanelSection,
  PanelSectionRow,
  TextField,
} from "@decky/ui";
import { useState } from "react";
import { getAppInstalldir, NexusGameHit, searchNexusGames } from "./api";
import { saveCustomGame } from "./games";

const PRESETS: [string, string][] = [
  ["", "Game folder"],
  ["Mods", "Mods"],
  ["BepInEx/plugins", "BepInEx/plugins"],
  ["Content/Paks/~mods", "Content/Paks/~mods (Unreal)"],
];

export function GenericSetup(props: {
  appId: number;
  name: string;
  onDone: () => void;
}) {
  const [query, setQuery] = useState(props.name);
  const [hits, setHits] = useState<NexusGameHit[]>();
  const [nexus, setNexus] = useState<NexusGameHit>();
  const [target, setTarget] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const search = async () => {
    setBusy(true);
    const r = await searchNexusGames(query).catch(() => undefined);
    setBusy(false);
    setHits(r?.games ?? []);
    setMsg(r?.ok ? "" : r?.error ?? "Search failed");
  };

  const save = async () => {
    if (!nexus) return;
    const r = await getAppInstalldir(props.appId).catch(() => undefined);
    if (!r?.ok) {
      setMsg("This game is not installed through Steam on this device.");
      return;
    }
    saveCustomGame({
      appId: props.appId,
      displayName: props.name,
      nexusDomain: nexus.domain,
      installDirName: r.installdir,
      genericTarget: target.trim().replace(/^\/+|\/+$/g, ""),
    });
    props.onDone();
  };

  return (
    <PanelSection title="Set up modding">
      <PanelSectionRow>
        <Field label={props.name}>
          Not supported out of the box. Generic mode merges each mod's files
          into one folder you choose, backs up any game file a mod replaces,
          and puts it back on uninstall. It does not install mod loaders.
        </Field>
      </PanelSectionRow>
      <PanelSectionRow>
        <TextField
          label="1. Nexus Mods game"
          value={query}
          onChange={(e) => setQuery(e?.target?.value ?? "")}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" disabled={busy} onClick={search}>
          {busy ? "Searching…" : "Search"}
        </ButtonItem>
      </PanelSectionRow>
      {hits?.length === 0 && (
        <PanelSectionRow>
          <Field label="No match">
            Try a shorter name, or type the name from the game's
            nexusmods.com address (nexusmods.com/hollowknight → hollowknight).
          </Field>
        </PanelSectionRow>
      )}
      {hits !== undefined && /^[a-z0-9]+$/.test(query.trim()) && (
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            onClick={() =>
              setNexus({ domain: query.trim(), name: query.trim(), mods: 0 })
            }
          >
            {nexus?.domain === query.trim() ? "✓ " : ""}
            Use nexusmods.com/{query.trim()}
          </ButtonItem>
        </PanelSectionRow>
      )}
      {hits?.map((g) => (
        <PanelSectionRow key={g.domain}>
          <ButtonItem
            layout="below"
            onClick={() => setNexus(g)}
            description={`${g.mods} mods`}
          >
            {nexus?.domain === g.domain ? "✓ " : ""}
            {g.name}
          </ButtonItem>
        </PanelSectionRow>
      ))}
      <PanelSectionRow>
        <TextField
          label="2. Mods folder, inside the game folder"
          description="Empty = the game folder itself"
          value={target}
          onChange={(e) => setTarget(e?.target?.value ?? "")}
        />
      </PanelSectionRow>
      {PRESETS.map(([path, label]) => (
        <PanelSectionRow key={label}>
          <ButtonItem layout="below" onClick={() => setTarget(path)}>
            {target === path ? "✓ " : ""}
            {label}
          </ButtonItem>
        </PanelSectionRow>
      ))}
      {msg && (
        <PanelSectionRow>
          <Field label="⚠">{msg}</Field>
        </PanelSectionRow>
      )}
      <PanelSectionRow>
        <ButtonItem layout="below" disabled={!nexus} onClick={save}>
          {nexus ? `Save: ${nexus.name}` : "Pick a Nexus game first"}
        </ButtonItem>
      </PanelSectionRow>
    </PanelSection>
  );
}
