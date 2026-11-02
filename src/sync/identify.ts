// Translates what the bridge reports (Resolve's local IDs) into the session's
// collab IDs (SPEC §3.4, §19.5), matching unlinked bins by path and unlinked
// clips by file fingerprint.

import { type Fingerprint, type MediaPool, ROOT, binPath, emptyPool, newId } from "./media-pool.ts";

// As reported by the bridge (mp.bin / mp.clip events).
export interface LocalBin {
  id: string;
  name: string;
  parent: string; // local ID, "" for the root bin
}

export interface LocalClip {
  id: string;
  rcId: string; // "" when not linked yet
  name: string;
  bin: string; // local bin ID
  color: string;
  flags: string[];
  meta: Record<string, string>;
  path: string;
}

export interface LocalState {
  bins: Map<string, LocalBin>;
  clips: Map<string, LocalClip>;
}

export interface IdentifyInput {
  local: LocalState;
  binMap: Map<string, string>; // local bin ID → collab ID, updated in place
  session: MediaPool;
  // Fingerprint by path: undefined while still being computed, null when the
  // file can't be read.
  fingerprint: (path: string) => Fingerprint | null | undefined;
}

export interface Identified {
  model: MediaPool;
  clipIds: Map<string, string>; // collab ID → local clip ID
  binIds: Map<string, string>; // collab ID → local bin ID
  links: { local: string; rcId: string }[]; // rcIds to write into Resolve
  notReady: string[]; // collab IDs of clips still being fingerprinted
}

const sameFile = (a: Fingerprint | null, b: Fingerprint | null) => !!a && !!b && a.name === b.name && a.size === b.size && a.hash === b.hash;

export function identify({ local, binMap, session, fingerprint }: IdentifyInput): Identified {
  const model = emptyPool();
  const binIds = new Map<string, string>();
  const clipIds = new Map<string, string>();
  const links: Identified["links"] = [];
  const notReady: string[] = [];

  // Bins, parent-first so paths can be built.
  const depth = (bin: LocalBin): number => {
    let n = 0;
    for (let at: LocalBin | undefined = bin; at && at.parent; at = local.bins.get(at.parent)) n++;
    return n;
  };
  const bins = [...local.bins.values()].sort((a, b) => depth(a) - depth(b));
  const sessionByPath = new Map<string, string>();
  for (const id of Object.keys(session.bins)) sessionByPath.set(binPath(session, id), id);
  const claimedBins = new Set<string>();
  for (const bin of bins) if (binMap.has(bin.id)) claimedBins.add(binMap.get(bin.id)!);

  for (const bin of bins) {
    if (!bin.parent) {
      binMap.set(bin.id, ROOT);
      binIds.set(ROOT, bin.id);
      model.bins[ROOT]!.name = bin.name;
      continue;
    }
    const parent = binMap.get(bin.parent);
    if (!parent) continue; // parent not reported yet
    let id = binMap.get(bin.id);
    if (!id || binIds.has(id)) {
      const path = `${binPath(model, parent)}${bin.name}/`;
      const match = sessionByPath.get(path);
      id = match && !claimedBins.has(match) ? match : newId();
      claimedBins.add(id);
      binMap.set(bin.id, id);
    }
    binIds.set(id, bin.id);
    model.bins[id] = { id, name: bin.name, parent };
  }

  // Clips: linked ones first, so matching can't steal a linked clip's ID.
  const clips = [...local.clips.values()];
  const claimedClips = new Set<string>();
  const unlinked: LocalClip[] = [];
  for (const clip of clips) {
    if (clip.rcId && /^[0-9a-f]{32}$/.test(clip.rcId) && !claimedClips.has(clip.rcId)) claimedClips.add(clip.rcId);
    else unlinked.push(clip);
  }
  const add = (clip: LocalClip, id: string, file: Fingerprint | null) => {
    const bin = binMap.get(clip.bin);
    if (!bin) return;
    clipIds.set(id, clip.id);
    model.clips[id] = { id, name: clip.name, bin, color: clip.color, flags: [...clip.flags].sort(), meta: { ...clip.meta }, file };
  };
  for (const clip of clips) {
    if (unlinked.includes(clip)) continue;
    const file = clip.path ? fingerprint(clip.path) : null;
    if (file === undefined) notReady.push(clip.rcId);
    add(clip, clip.rcId, file ?? null);
  }

  const candidates = Object.values(session.clips).filter((c) => !claimedClips.has(c.id) && c.file);
  for (const clip of unlinked) {
    const file = clip.path ? fingerprint(clip.path) : null;
    if (file === undefined) continue; // decide once the fingerprint is known
    const path = binMap.has(clip.bin) ? binPath(model, binMap.get(clip.bin)!) : "";
    const match =
      candidates.find((c) => !claimedClips.has(c.id) && sameFile(c.file, file) && binPath(session, c.bin) === path) ??
      candidates.find((c) => !claimedClips.has(c.id) && sameFile(c.file, file));
    const id = match ? match.id : newId();
    claimedClips.add(id);
    links.push({ local: clip.id, rcId: id });
    add(clip, id, file);
    notReady.push(id); // proposed or reconciled once the link is written
  }

  return { model, clipIds, binIds, links, notReady };
}
